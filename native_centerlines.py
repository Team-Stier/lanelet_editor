"""Read XYZ boundaries; return Lanelet2's own centerline without changing the map."""
import json
import math
import sys
from importlib.metadata import version
import lanelet2


def calculate(items):
    shared_points = {}
    def line(points):
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError('경계에는 두 점 이상이 필요합니다.')
        vertices = []
        for p in points:
            if len(p) not in (3,4) or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p[:3]):
                raise ValueError('유효한 XYZ 좌표가 필요합니다.')
            identity = str(p[3]) if len(p) == 4 else None
            if identity is not None and identity in shared_points:
                point = shared_points[identity]
                if [point.x, point.y, point.z] != p[:3]:
                    raise ValueError('동일 point ID의 좌표가 서로 다릅니다.')
            else:
                point = lanelet2.core.Point3d(lanelet2.core.getId(), *p[:3])
                if identity is not None:
                    shared_points[identity] = point
            vertices.append(point)
        return lanelet2.core.LineString3d(lanelet2.core.getId(), vertices)
    result, errors = [], []
    for item in items:
        try:
            lane = lanelet2.core.Lanelet(lanelet2.core.getId(), line(item['left']), line(item['right']))
            if item.get('centerline'):
                lane.centerline = line(item['centerline'])
            points = [[p.x, p.y, p.z] for p in lane.centerline]
            if not points or not all(math.isfinite(v) for p in points for v in p):
                raise ValueError('Lanelet2 중심선 좌표가 유효하지 않습니다.')
            result.append({'id': str(item['id']), 'points': points,
                           'source': 'stored' if item.get('centerline') else 'lanelet2'})
        except Exception as exc:
            errors.append({'id': str(item.get('id', '?')), 'error': str(exc)})
    return {'engine': 'Lanelet2', 'version': version('lanelet2'), 'centerlines': result, 'errors': errors}


if __name__ == '__main__':
    if '--test' in sys.argv:
        sample={'id':'1','left':[[0,2,1],[10,2,3]],'right':[[0,-2,1],[10,-2,3]]}
        result=calculate([sample]); assert not result['errors']
        assert result['centerlines'][0]['points'][0] == [0,0,1]
        assert result['centerlines'][0]['points'][-1] == [10,0,3]
        sample['right']=[[0,-4,1],[10,-4,3]]
        assert calculate([sample])['centerlines'][0]['points'][0][1] == -1
        sample['centerline']=[[0,.5,1],[10,.5,3]]
        assert calculate([sample])['centerlines'][0]['points']==sample['centerline']
        print('native centerline XYZ, edited boundary, custom centerline passed')
    else:
        print(json.dumps(calculate(json.load(sys.stdin)), allow_nan=False))
