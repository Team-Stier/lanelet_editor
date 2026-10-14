#!/usr/bin/env python3
"""Small runnable regression checks: python server_test.py."""
import copy
import json
import http.client
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import server

OSM = b'''<osm version="0.6" generator="original"><note>retain me</note>
<node id="1" lat="37.2" lon="126.7" version="3"><tag k="local_x" v="0"/><tag k="local_y" v="0"/><tag k="local_z" v="7.123456789012345"/><tag k="custom" v="first"/><tag k="custom" v="second"/><extension a="keep"/></node>
<node id="2" lat="37.2" lon="126.7"><tag k="local_x" v="10"/><tag k="local_y" v="0"/></node>
<node id="3" lat="37.2" lon="126.7"><tag k="local_x" v="0"/><tag k="local_y" v="2"/></node>
<node id="4" lat="37.2" lon="126.7"><tag k="local_x" v="10"/><tag k="local_y" v="2"/></node>
<way id="10"><nd ref="1"/><nd ref="2"/><tag k="custom" v="way"/></way>
<way id="11"><nd ref="3"/><nd ref="4"/></way>
<relation id="20"><member type="way" ref="10" role="right"/><member type="way" ref="11" role="left"/><tag k="type" v="lanelet"/></relation></osm>'''


class EditorChecks(unittest.TestCase):
    def test_round_trip_edit_and_preservation(self):
        project = server.parse_osm(OSM)
        project['nodes'][0]['x'] = 1.123456789012345
        encoded = server.export_osm(project)
        restored = server.parse_osm(encoded)
        self.assertEqual(restored['nodes'][0]['x'], project['nodes'][0]['x'])
        self.assertEqual(restored['nodes'][0]['z'], project['nodes'][0]['z'])
        root = ET.fromstring(encoded)
        self.assertEqual(root.attrib['generator'], 'original')
        self.assertEqual(root.find('note').text, 'retain me')
        node = root.find('node')
        self.assertEqual(node.attrib['version'], '3')
        self.assertEqual(node.find('extension').attrib['a'], 'keep')
        self.assertEqual([t.attrib['v'] for t in node.findall('tag') if t.attrib['k'] == 'custom'], ['first', 'second'])
        e, n = server.FROM_GEO.transform(float(node.attrib['lon']), float(node.attrib['lat']))
        self.assertAlmostEqual(e - server.ORIGIN[0], project['nodes'][0]['x'], places=7)
        self.assertAlmostEqual(n - server.ORIGIN[1], project['nodes'][0]['y'], places=7)
        shifted = copy.deepcopy(project)
        shifted['origin'] = [302600, 4124150, 5]
        shifted_back = server.parse_osm(server.export_osm(shifted))
        self.assertEqual(shifted_back['origin'], shifted['origin'])
        self.assertEqual(shifted_back['nodes'][0]['z'], shifted['nodes'][0]['z'])
        project['nodes'][0]['tags']['custom'] = 'edited'
        edited = ET.fromstring(server.export_osm(project)).find('node')
        self.assertEqual([t.attrib['v'] for t in edited.findall('tag') if t.attrib['k'] == 'custom'], ['edited', 'edited'])

    def test_bad_inputs_and_dangling_references(self):
        for axis_value in [float('nan'), float('inf'), True]:
            project = server.parse_osm(OSM)
            project['nodes'][0]['x'] = axis_value
            with self.assertRaises(ValueError):
                server.export_osm(project)
        project = server.parse_osm(OSM)
        project['ways'][0]['nodes'].append('9999')
        self.assertEqual(server.validate_project(project)['issues'][0]['code'], 'missing_node')
        with self.assertRaises(ValueError):
            server.export_osm(project)
        for xml in [b'<!DOCTYPE osm [<!ENTITY e "x">]><osm/>', b'<osm><node id="1"/></osm>']:
            with self.assertRaises((ValueError, KeyError)):
                server.parse_osm(xml)

    def test_http_routes_and_path_guards(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'ROOT', Path(directory).resolve()), patch.object(server, 'SAVES', Path(directory).resolve() / 'saved'):
            httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port)
            try:
                connection.request('POST', '/api/import', b'\xef\xbb\xbf' + OSM)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                project = json.loads(response.read())
                self.assertEqual(len(project['nodes']), 4)
                connection.request('POST', '/api/save', server.json_bytes({'name': 'check', 'project': project}))
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                saved = json.loads(response.read())
                connection.request('GET', '/api/saves')
                response = connection.getresponse()
                self.assertEqual(json.loads(response.read())['saves'][0]['name'], saved['name'])
                for url_key in ('jsonUrl', 'osmUrl'):
                    connection.request('GET', saved[url_key])
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    data = response.read()
                    restored = server.parse_osm(data) if url_key == 'osmUrl' else json.loads(data)
                    self.assertEqual(len(restored['nodes']), 4)
                for method, path, headers in [('GET', '/.git/config', {}), ('HEAD', '/%2e%2e/outside', {}),
                                              ('GET', '/api/saves', {'Host': 'attacker.test'})]:
                    connection.request(method, path, headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 403)
                    response.read()
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()

    def test_real_positive_overlap_and_save(self):
        project = server.parse_osm(OSM)
        duplicate = copy.deepcopy(project['relations'][0])
        duplicate['id'] = '21'
        project['relations'].append(duplicate)
        result = server.validate_project(project)
        self.assertEqual(result['stats']['errors'], 0)
        overlap = next(i for i in result['issues'] if i['code'] == 'polygon_overlap')
        self.assertEqual(overlap['severity'], 'info')
        self.assertAlmostEqual(overlap['area'], 20)
        with tempfile.TemporaryDirectory() as directory:
            first = server.save_project('작업', project, directory)
            second = server.save_project('작업', project, directory)
            self.assertNotEqual(first['name'], second['name'])
            self.assertEqual(len(list(Path(directory).glob('*'))), 4)
            saved = json.loads((Path(directory) / (first['name'] + '.lanelet.json')).read_text())
            self.assertEqual(saved['relations'], project['relations'])
            for name in ['../escape', '/outside', '.private', '..', '']:
                with self.assertRaises(ValueError):
                    server.save_project(name, project, directory)


if __name__ == '__main__':
    unittest.main()
