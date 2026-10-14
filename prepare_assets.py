#!/usr/bin/env python3
"""Prepare compact, georeferenced browser assets from the preserved scene meshes."""
import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'outputs/lanelet-map-repair'
DEST = ROOT / 'editor-assets'


def prepare():
    DEST.mkdir(exist_ok=True)
    report = json.loads((SOURCE / 'asset_validation.json').read_text())
    manifest = {
        'coordinateSystem': 'local ENU metres',
        'overview': {'url': '/outputs/lanelet-map-repair/assets/asset_overview.png',
                     'bounds': [-430, -785, 145, 590]},
        'tiles': [{'id': t['id'], 'url': f"/outputs/lanelet-map-repair/atlas/{t['id']}-assets.jpg",
                   'bounds': t['bounds']} for t in report['tiles']
                  if (SOURCE / 'atlas' / f"{t['id']}-assets.jpg").is_file()],
        'meshes': [],
    }
    files = sorted((SOURCE / 'assets').glob('road*.npz')) + sorted((SOURCE / 'assets').glob('line*.npz'))
    for path in files:
        with np.load(path, allow_pickle=False) as mesh:
            vertices, triangles = mesh['vertices'], mesh['triangles']
            # Static-batched vertices already contain Unity world coordinates.
            used, remap = np.unique(triangles, return_inverse=True)
            positions = vertices[used][:, [0, 2, 1]] * [-1, -1, 1]
            if not np.isfinite(positions).all():
                raise ValueError(f'Non-finite vertices: {path.name}')
            positions.astype('<f4').tofile(DEST / f'{path.stem}.positions.bin')
            remap.astype('<u4').tofile(DEST / f'{path.stem}.indices.bin')
        color = '#e4ba39' if 'yellow' in path.stem else '#dedfd5' if 'line' in path.stem else '#454950'
        manifest['meshes'].append({'name': path.stem,
            'positionsUrl': f'/editor-assets/{path.stem}.positions.bin',
            'indicesUrl': f'/editor-assets/{path.stem}.indices.bin', 'color': color,
            'vertexCount': len(positions), 'triangleCount': len(remap) // 3,
            'bounds': [positions.min(axis=0).tolist(), positions.max(axis=0).tolist()]})
    (DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f"Prepared {len(manifest['tiles'])} tiles and {len(manifest['meshes'])} meshes in {DEST}")
    return manifest


if __name__ == '__main__':
    prepare()
