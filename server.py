#!/usr/bin/env python3
"""Local Lanelet editor: lossless OSM/JSON I/O and geometry diagnostics."""
import argparse
from collections import Counter
from datetime import datetime, timezone
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from urllib.parse import unquote, urlsplit
import uuid
import xml.etree.ElementTree as ET

from pyproj import Transformer
from pyproj.exceptions import ProjError
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree
from shapely.validation import explain_validity

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'outputs/lanelet-map-repair/map/kcity_lanelet2.osm'
SAVES = ROOT / 'saved'
ORIGIN = [302595.0, 4124145.0, 0.0]
CRS = 'EPSG:32652'
MAX_BODY = 150 * 1024 * 1024
TO_GEO = Transformer.from_crs(CRS, 'EPSG:4326', always_xy=True)
FROM_GEO = Transformer.from_crs('EPSG:4326', CRS, always_xy=True)
SAVE_LOCK = threading.Lock()
ID_PATTERN = re.compile(r'-?[0-9]+\Z')
XML_BAD = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]')


def text_value(value, label='text'):
    if not isinstance(value, str) or XML_BAD.search(value):
        raise ValueError(f'{label} must be valid XML text')
    return value


def identifier(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not ID_PATTERN.fullmatch(str(value)):
        raise ValueError(f'Invalid OSM identifier: {value!r}')
    return str(value)


def finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{label} must be a finite number')
    return float(value)


def xml_parse(data):
    if isinstance(data, bytes):
        data = data.decode('utf-8-sig')
    check = data.upper()
    if '<!DOCTYPE' in check or '<!ENTITY' in check:
        raise ValueError('XML declarations with DTD/entities are not supported')
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f'Invalid OSM XML: {exc}') from exc


def attributes(value, label):
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    for k, v in value.items():
        text_value(k, label)
        text_value(v, label)
        if not re.fullmatch(r'(?:\{[^{}]+\})?[A-Za-z_][A-Za-z0-9_.-]*', k):
            raise ValueError(f'Invalid XML attribute name: {k}')
    return value


def normalize_project(project):
    """Validate the editable schema; keep extension fields and original metadata."""
    if not isinstance(project, dict) or project.get('version', 1) != 1:
        raise ValueError('Expected a version 1 Lanelet project object')
    if project.get('crs', CRS) != CRS:
        raise ValueError(f'Only {CRS} project coordinates are supported')
    project.setdefault('version', 1)
    project.setdefault('crs', CRS)
    origin = project.setdefault('origin', ORIGIN.copy())
    if not isinstance(origin, list) or len(origin) != 3:
        raise ValueError('origin must contain three finite coordinates')
    for n in origin:
        finite(n, 'origin')
    meta = project.setdefault('meta', {})
    if not isinstance(meta, dict):
        raise ValueError('meta must be an object')
    attributes(meta.get('osmAttributes', {}), 'OSM attributes')
    check_extras(meta.get('extraChildren', []), {'node', 'way', 'relation'})
    for kind in ('nodes', 'ways', 'relations'):
        values = project.get(kind)
        if not isinstance(values, list):
            raise ValueError(f'{kind} must be an array')
        seen = set()
        for item in values:
            if not isinstance(item, dict):
                raise ValueError(f'Invalid {kind} entry')
            item['id'] = identifier(item.get('id'))
            if item['id'] in seen:
                raise ValueError(f"Duplicate {kind} identifier: {item['id']}")
            seen.add(item['id'])
            tags = item.setdefault('tags', {})
            if not isinstance(tags, dict):
                raise ValueError('tags must be an object')
            for key, value in tags.items():
                text_value(key, 'tag key')
                text_value(value, 'tag value')
            attributes(item.get('osmAttributes', {}), 'element attributes')
            if 'tagPairs' in item:
                if not isinstance(item['tagPairs'], list):
                    raise ValueError('tagPairs must be an array')
                for pair in item['tagPairs']:
                    if not isinstance(pair, list) or len(pair) != 2:
                        raise ValueError('Invalid tag pair')
                    text_value(pair[0]); text_value(pair[1])
            check_extras(item.get('extraChildren', []), {'tag', 'nd', 'member'})
            if kind == 'nodes':
                for axis in ('x', 'y', 'z'):
                    item[axis] = finite(item.get(axis, 0 if axis == 'z' else None), f'node {item["id"]} {axis}')
                for coordinate in ('lat', 'lon'):
                    if coordinate in item:
                        finite(item[coordinate], coordinate)
            elif kind == 'ways':
                if not isinstance(item.get('nodes'), list):
                    raise ValueError('way nodes must be an array')
                item['nodes'] = [identifier(i) for i in item['nodes']]
                if 'ndAttributes' in item:
                    if not isinstance(item['ndAttributes'], list) or len(item['ndAttributes']) != len(item['nodes']):
                        raise ValueError('ndAttributes must match way nodes')
                    for attrs in item['ndAttributes']:
                        attributes(attrs, 'nd attributes')
            else:
                if not isinstance(item.get('members'), list):
                    raise ValueError('relation members must be an array')
                for member in item['members']:
                    if not isinstance(member, dict) or member.get('type') not in ('node', 'way', 'relation'):
                        raise ValueError('Invalid relation member type')
                    member['ref'] = identifier(member.get('ref'))
                    text_value(member.get('role', ''), 'member role')
                    attributes(member.get('osmAttributes', {}), 'member attributes')
    return project


def check_extras(extras, forbidden):
    if not isinstance(extras, list):
        raise ValueError('extraChildren must be an array')
    for item in extras:
        text_value(item)
        if xml_parse(item).tag in forbidden:
            raise ValueError('Core OSM elements cannot be hidden in extraChildren')


def parse_osm(data):
    root = xml_parse(data)
    if root.tag != 'osm':
        raise ValueError('The XML root must be <osm>')
    origin = [float(root.attrib.get('lanelet_editor_origin_' + axis, str(value)))
              for axis, value in zip('xyz', ORIGIN)]
    if root.attrib.get('lanelet_editor_crs', CRS) != CRS:
        raise ValueError('Unsupported OSM project CRS')
    project = {'version': 1, 'crs': CRS, 'origin': origin, 'nodes': [], 'ways': [], 'relations': [],
               'meta': {'osmAttributes': dict(root.attrib), 'extraChildren': []}}
    for element in root:
        if element.tag not in ('node', 'way', 'relation'):
            project['meta']['extraChildren'].append(ET.tostring(element, encoding='unicode'))
            continue
        pairs = [[t.attrib['k'], t.attrib['v']] for t in element.findall('tag')]
        tags = dict(pairs)
        item = {'id': element.attrib['id'], 'tags': tags}
        attrs = {k: v for k, v in element.attrib.items() if k not in ('id', 'lat', 'lon')}
        if attrs:
            item['osmAttributes'] = attrs
        # Only duplicate keys need a second representation; ordinary tag order is preserved by dict.
        if len(pairs) != len(tags):
            item['tagPairs'] = pairs
        known = {'tag'}
        if element.tag == 'node':
            if ('local_x' in tags) != ('local_y' in tags):
                raise ValueError(f'Node {item["id"]} has incomplete local coordinates')
            if 'local_x' in tags:
                item['x'], item['y'] = float(tags['local_x']), float(tags['local_y'])
            else:
                lon, lat = float(element.attrib['lon']), float(element.attrib['lat'])
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError('Latitude/longitude out of range')
                e, n = FROM_GEO.transform(lon, lat, errcheck=True)
                item['x'], item['y'] = e - origin[0], n - origin[1]
            item['z'] = float(tags['local_z']) if 'local_z' in tags else float(tags.get('ele', str(origin[2]))) - origin[2]
            for k in ('lat', 'lon'):
                if k in element.attrib:
                    item[k] = float(element.attrib[k])
        elif element.tag == 'way':
            known.add('nd')
            nds = element.findall('nd')
            item['nodes'] = [nd.attrib['ref'] for nd in nds]
            nd_attrs = [{k: v for k, v in nd.attrib.items() if k != 'ref'} for nd in nds]
            if any(nd_attrs):
                item['ndAttributes'] = nd_attrs
        else:
            known.add('member')
            item['members'] = []
            for member in element.findall('member'):
                entry = {k: member.attrib.get(k, '') for k in ('type', 'ref', 'role')}
                extra = {k: v for k, v in member.attrib.items() if k not in entry}
                if extra:
                    entry['osmAttributes'] = extra
                item['members'].append(entry)
        extra = [ET.tostring(c, encoding='unicode') for c in element if c.tag not in known]
        if extra:
            item['extraChildren'] = extra
        project[element.tag + 's'].append(item)
    return normalize_project(project)


def reference_issues(project):
    ids = {kind[:-1]: {v['id'] for v in project[kind]} for kind in ('nodes', 'ways', 'relations')}
    issues = []
    for way in project['ways']:
        for ref in dict.fromkeys(way['nodes']):
            if ref not in ids['node']:
                issues.append({'severity': 'error', 'code': 'missing_node', 'type': 'way', 'id': way['id'],
                               'ref': ref, 'message': f'노드 {ref} 참조가 없습니다.'})
    for relation in project['relations']:
        for member in relation['members']:
            if member['ref'] not in ids[member['type']]:
                issues.append({'severity': 'error', 'code': 'missing_member', 'type': 'relation', 'id': relation['id'],
                               'ref': member['ref'], 'message': f"{member['type']} {member['ref']} 참조가 없습니다."})
    return issues


def export_osm(project):
    project = normalize_project(project)
    missing = reference_issues(project)
    if missing:
        raise ValueError(f"Cannot export dangling references: {missing[0]['message']} ({len(missing)} total)")
    root_attrs = {'version': '0.6', **project['meta'].get('osmAttributes', {})}
    if project['origin'] != ORIGIN:
        root_attrs.update({'lanelet_editor_origin_' + axis: format(value, '.17g')
                           for axis, value in zip('xyz', project['origin'])})
        root_attrs['lanelet_editor_crs'] = CRS
    else:
        for axis in 'xyz':
            root_attrs.pop('lanelet_editor_origin_' + axis, None)
    root = ET.Element('osm', root_attrs)
    for extra in project['meta'].get('extraChildren', []):
        root.append(xml_parse(extra))
    origin = project['origin']
    for kind in ('nodes', 'ways', 'relations'):
        for item in project[kind]:
            attrs = {**item.get('osmAttributes', {}), 'id': item['id']}
            tags = dict(item['tags'])
            if kind == 'nodes':
                lon, lat = TO_GEO.transform(item['x'] + origin[0], item['y'] + origin[1], errcheck=True)
                if not (math.isfinite(lon) and math.isfinite(lat)):
                    raise ValueError('Node coordinates cannot be projected')
                attrs.update(lon=format(lon, '.17g'), lat=format(lat, '.17g'))
                tags.update(local_x=format(item['x'], '.17g'), local_y=format(item['y'], '.17g'),
                            local_z=format(item['z'], '.17g'), ele=format(item['z'] + origin[2], '.17g'))
            element = ET.SubElement(root, kind[:-1], attrs)
            if kind == 'ways':
                nd_attrs = item.get('ndAttributes')
                for i, ref in enumerate(item['nodes']):
                    ET.SubElement(element, 'nd', {**(nd_attrs[i] if nd_attrs else {}), 'ref': ref})
            elif kind == 'relations':
                for member in item['members']:
                    ET.SubElement(element, 'member', {**member.get('osmAttributes', {}),
                        'type': member['type'], 'ref': member['ref'], 'role': member.get('role', '')})
            pairs = item.get('tagPairs', [])
            old_tags = dict(pairs)
            emitted = set()
            for key, value in pairs:
                if key in tags:
                    ET.SubElement(element, 'tag', {'k': key, 'v': value if tags[key] == old_tags[key] else tags[key]})
                    emitted.add(key)
            for key, value in tags.items():
                if key not in emitted:
                    ET.SubElement(element, 'tag', {'k': key, 'v': value})
            for extra in item.get('extraChildren', []):
                element.append(xml_parse(extra))
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def validate_project(project):
    project = normalize_project(project)
    issues = reference_issues(project)
    nodes = {n['id']: n for n in project['nodes']}
    ways = {w['id']: w for w in project['ways']}
    def add(severity, code, kind, ident, message, **extra):
        issues.append({'severity': severity, 'code': code, 'type': kind, 'id': ident, 'message': message, **extra})
    lines = {}
    for way in project['ways']:
        coords = [(nodes[n]['x'], nodes[n]['y']) for n in way['nodes'] if n in nodes]
        if len(coords) < 2:
            add('error', 'short_way', 'way', way['id'], 'Way에는 노드가 두 개 이상 필요합니다.')
        elif len(coords) == len(way['nodes']):
            line = LineString(coords)
            lines[way['id']] = coords
            if line.length <= 1e-8:
                add('error', 'zero_length_way', 'way', way['id'], 'Way 길이가 0입니다.')
            elif not line.is_simple:
                add('warning', 'self_intersecting_way', 'way', way['id'], 'Way가 자체 교차합니다.')
    polygons, lanelets, heights = [], [], []
    for relation in project['relations']:
        if relation['tags'].get('type') != 'lanelet':
            continue
        sides = {role: [m for m in relation['members'] if m['role'] == role] for role in ('left', 'right')}
        if any(len(v) != 1 or v[0]['type'] != 'way' for v in sides.values()):
            add('error', 'lanelet_boundaries', 'relation', relation['id'], 'Lanelet에는 left/right way가 하나씩 필요합니다.')
            continue
        left_id, right_id = sides['left'][0]['ref'], sides['right'][0]['ref']
        left, right = lines.get(left_id), lines.get(right_id)
        if left is None or right is None:
            continue
        direct = math.dist(left[0], right[0]) + math.dist(left[-1], right[-1])
        reverse = math.dist(left[0], right[-1]) + math.dist(left[-1], right[0])
        if reverse + 1e-6 < direct:
            add('warning', 'boundary_direction', 'relation', relation['id'], '좌우 경계의 진행 방향이 반대입니다.')
            right = right[::-1]
        polygon = Polygon(left + right[::-1])
        if not polygon.is_valid:
            add('error', 'invalid_polygon', 'relation', relation['id'], '유효하지 않은 차로 면: ' + explain_validity(polygon))
        elif polygon.area <= 1e-8:
            add('error', 'zero_area_lanelet', 'relation', relation['id'], '차로 면적이 0입니다.')
        else:
            polygons.append(polygon)
            lanelets.append(relation)
            nids = ways[left_id]['nodes'] + ways[right_id]['nodes']
            heights.append(sum(nodes[n]['z'] for n in nids) / len(nids))
    overlap_count = 0
    if polygons:
        tree = STRtree(polygons)
        for i, polygon in enumerate(polygons):
            for j_raw in tree.query(polygon, predicate='intersects'):
                j = int(j_raw)
                if j <= i:
                    continue
                intersection = polygon.intersection(polygons[j])
                if intersection.area <= 1e-6:
                    continue
                overlap_count += 1
                dz = abs(heights[i] - heights[j])
                code = 'overlap_different_elevation' if dz > 2 else 'polygon_overlap'
                add('info', code, 'relation', lanelets[i]['id'],
                    f"차로 {lanelets[j]['id']}와 XY 면적 {intersection.area:.4f} m² 중첩 (교차로·합류·높이 확인).",
                    otherId=lanelets[j]['id'], area=intersection.area, elevationDifference=dz,
                    bounds=list(intersection.bounds))
    counts = Counter(i['severity'] for i in issues)
    return {'issues': issues, 'stats': {'nodes': len(nodes), 'ways': len(ways),
        'relations': len(project['relations']), 'lanelets': sum(r['tags'].get('type') == 'lanelet' for r in project['relations']),
        'validLaneletPolygons': len(polygons), 'overlapPairs': overlap_count,
        'errors': counts['error'], 'warnings': counts['warning'], 'info': counts['info']}}


def json_bytes(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def parse_json(data):
    def invalid_constant(value):
        raise ValueError(f'Non-finite JSON constant: {value}')
    return json.loads(data, parse_constant=invalid_constant)


def save_project(name, project, directory=None):
    if not isinstance(name, str) or len(name) > 100 or not name.strip() or '/' in name or '\\' in name or '..' in name or name.startswith('.'):
        raise ValueError('Save name must be 1–100 characters, without slashes, leading dots or ..')
    name = re.sub(r'[^\w .-]', '_', name, flags=re.UNICODE).strip(' .')
    if not name:
        raise ValueError('Empty save name')
    project = normalize_project(project)
    osm = export_osm(project)
    encoded = json_bytes(project)
    directory = Path(directory) if directory else SAVES
    directory.mkdir(parents=True, exist_ok=True)
    with SAVE_LOCK:
        stem = f'{name}-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")}-{uuid.uuid4().hex[:6]}'
        outputs = [(directory / f'{stem}.lanelet.json', encoded), (directory / f'{stem}.osm', osm)]
        published, temporary = [], []
        try:
            for destination, contents in outputs:
                with tempfile.NamedTemporaryFile(dir=directory, prefix='.saving-', delete=False) as stream:
                    temporary.append(Path(stream.name))
                    stream.write(contents)
                    stream.flush()
                    os.fsync(stream.fileno())
            for (destination, _), temp in zip(outputs, temporary):
                # link is an atomic create that refuses to overwrite an existing file.
                os.link(temp, destination)
                published.append(destination)
        except BaseException:
            for destination in published:
                destination.unlink(missing_ok=True)
            raise
        finally:
            for temp in temporary:
                temp.unlink(missing_ok=True)
    return {'name': stem, 'jsonUrl': f'/saved/{stem}.lanelet.json', 'osmUrl': f'/saved/{stem}.osm',
            'savedAt': datetime.now(timezone.utc).isoformat()}


@lru_cache(maxsize=1)
def source_project(mtime, size):
    project = parse_osm(SOURCE.read_bytes())
    project['meta']['source'] = 'outputs/lanelet-map-repair/map/kcity_lanelet2.osm'
    return json_bytes(project)


def native_centerlines(body):
    if not isinstance(body, list) or len(body) > 20000:
        raise ValueError('중심선 요청에는 Lanelet 배열이 필요합니다.')
    deps = Path(os.environ.get('LANELET_NATIVE_DEPS', '/private/tmp/morai-lanelet2-20260926/work/native_deps')).resolve()
    if not (deps / 'lanelet2').is_dir():
        raise ValueError('Lanelet2 런타임이 없습니다. LANELET_NATIVE_DEPS 경로를 확인하세요.')
    command = ['docker', 'run', '--rm', '-i', '--network=none', '--platform=linux/amd64', '--pull=never',
               '-v', str(deps)+':/native_deps:ro', '-v', str(ROOT / 'native_centerlines.py')+':/worker.py:ro',
               '-e', 'PYTHONPATH=/native_deps', 'python:3.11-slim', 'python', '/worker.py']
    try:
        result = subprocess.run(command, input=json_bytes(body), capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError('Lanelet2 계산을 실행하지 못했습니다. Docker 실행 상태를 확인하세요.') from exc
    if result.returncode:
        raise ValueError('Lanelet2 계산 실패: '+result.stderr.decode(errors='replace')[-1200:])
    return json.loads(result.stdout)


def static_path_allowed(path, candidate):
    if '\\' in path or not candidate.is_relative_to(ROOT):
        return False
    parts = Path(path.lstrip('/')).parts + candidate.relative_to(ROOT).parts
    return not any(p.startswith('.') or p.lower() == 'private' for p in parts)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def respond(self, data, status=200, content_type='application/json; charset=utf-8', filename=None):
        payload = data if isinstance(data, bytes) else json_bytes(data)
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(payload)

    def local_request(self):
        try:
            host = urlsplit('http://' + self.headers.get('Host', '')).hostname
            origin = self.headers.get('Origin')
            if host not in ('127.0.0.1', 'localhost', '::1'):
                return False
            if origin:
                parsed = urlsplit(origin)
                return parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1') and parsed.port == self.server.server_port
            return True
        except ValueError:
            return False

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')

    def do_GET(self):
        if not self.local_request():
            return self.respond({'error': 'Local origin required'}, 403)
        path = unquote(urlsplit(self.path).path)
        try:
            if path == '/api/project':
                stat = SOURCE.stat()
                return self.respond(source_project(stat.st_mtime_ns, stat.st_size))
            if path == '/api/assets':
                return self.respond((ROOT / 'editor-assets/manifest.json').read_bytes())
            if path == '/api/saves':
                saves = []
                if SAVES.exists():
                    for f in sorted(SAVES.glob('*.lanelet.json'), key=lambda f: f.stat().st_mtime_ns, reverse=True):
                        stem = f.name[:-len('.lanelet.json')]
                        saves.append({'name': stem, 'jsonUrl': '/saved/' + f.name,
                            'osmUrl': '/saved/' + stem + '.osm', 'bytes': f.stat().st_size,
                            'savedAt': datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).isoformat()})
                return self.respond({'saves': saves})
            if path.startswith('/api/'):
                return self.respond({'error': 'Unknown API route'}, 404)
            candidate = (ROOT / path.lstrip('/')).resolve()
            if not static_path_allowed(path, candidate):
                return self.respond({'error': 'Path denied'}, 403)
            if candidate != ROOT and not candidate.is_file():
                return self.respond({'error': 'Not found'}, 404)
            return super().do_GET()
        except (ValueError, KeyError, TypeError, OverflowError, ProjError) as exc:
            self.respond({'error': str(exc)}, 400)
        except FileNotFoundError:
            self.respond({'error': 'Required source/asset file is missing'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self):
        # Apply the same path/origin guard as GET instead of SimpleHTTPRequestHandler's bypass.
        if not self.local_request():
            self.send_error(403)
            return
        path = unquote(urlsplit(self.path).path)
        candidate = (ROOT / path.lstrip('/')).resolve()
        if not static_path_allowed(path, candidate):
            self.send_error(403)
            return
        super().do_HEAD()

    def do_POST(self):
        if not self.local_request():
            return self.respond({'error': 'Local origin required'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.respond({'error': f'Request body must be 1–{MAX_BODY} bytes'}, 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError('Incomplete request body')
            path = urlsplit(self.path).path
            if path == '/api/import':
                project = parse_osm(data) if data.decode('utf-8-sig').lstrip().startswith('<') else normalize_project(parse_json(data))
                return self.respond(project)
            body = parse_json(data)
            if path == '/api/centerlines':
                return self.respond(native_centerlines(body))
            project = body.get('project', body) if isinstance(body, dict) else body
            if path == '/api/export':
                return self.respond(export_osm(project), content_type='application/xml; charset=utf-8', filename='lanelet-map.osm')
            if path == '/api/save':
                return self.respond(save_project(body.get('name', 'lanelet-map'), project), 201)
            if path == '/api/validate':
                return self.respond(validate_project(project))
            return self.respond({'error': 'Unknown API route'}, 404)
        except (ValueError, KeyError, TypeError, OverflowError, ProjError) as exc:
            self.respond({'error': str(exc)}, 400)
        except OSError as exc:
            self.respond({'error': f'File operation failed: {exc.strerror}'}, 500)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Lanelet editor: http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
