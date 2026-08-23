#!/usr/bin/env python3
"""Convertit les maillages du dépôt elpimous/ylo-2 en un paquet binaire compact.

Les visuels d'origine sont des COLLADA texturés (et un STL pour la batterie).
On les charge, on découpe les normales sur les arêtes vives, on décime si
nécessaire, puis on écrit :

    assets/ylo2-geometry.bin    positions f32, normales f32, index u32
    assets/ylo2-geometry.json   table des pièces (offsets, comptes, bornes)

`build.sh` embarque ensuite ce binaire gzippé + base64 dans la page, ce qui
permet d'ouvrir index.html en file:// sans requête réseau.

Usage :
    python3 tools/convert_meshes.py --repo /chemin/vers/ylo-2
"""
import argparse
import json
import os
import struct
import sys

import numpy as np

# nom logique -> (chemin dans le dépôt, budget de triangles)
PARTS = {
    "trunk":       ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_body.dae", 40000),
    "cover":       ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_cover.dae", 45000),
    "abad_motors": ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_abad_motors.dae", 20000),
    "accessories": ("champ_for_ylo2/ylo2_description/meshes/body/textured/accessories.dae", 20000),
    "battery":     ("champ_for_ylo2/ylo2_description/meshes/body/battery.stl", 20000),
    "d435":        ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_d435_textured.dae", 20000),
    "t265":        ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_t265_textured.dae", 20000),
    "hip":         ("champ_for_ylo2/ylo2_description/meshes/leg/textured/ylo2texturedhip.dae", 20000),
    "upper_leg":   ("champ_for_ylo2/ylo2_description/meshes/leg/textured/ylo2_textured_upper_leg.dae", 30000),
    "lower_leg":   ("champ_for_ylo2/ylo2_description/meshes/leg/textured/lower_leg.dae", 20000),
    "foot":        ("champ_for_ylo2/ylo2_description/meshes/leg/textured/fl_foot.dae", 14000),
    "lidar":       ("Wolf_for_ylo2/wolf_descriptions/ylo2_description/meshes/body/textured/Rp_lidar_A2.dae", 14000),
}

CREASE_DEG = 35.0


def load_mesh(path):
    import trimesh
    mesh = trimesh.load(path, force="mesh", process=True)
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("maillage vide")
    mesh.merge_vertices()
    mesh.remove_unreferenced_vertices()
    return mesh


def decimate(mesh, budget):
    if len(mesh.faces) <= budget:
        return mesh
    import fast_simplification
    import trimesh
    ratio = 1.0 - budget / float(len(mesh.faces))
    v, f = fast_simplification.simplify(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.int32),
        ratio,
    )
    return trimesh.Trimesh(vertices=v, faces=f, process=True)


def split_normals(mesh):
    """Normales lissées mais coupées sur les arêtes vives (pièces usinées)."""
    try:
        shaded = mesh.smooth_shaded
        return (np.asarray(shaded.vertices, dtype=np.float64),
                np.asarray(shaded.vertex_normals, dtype=np.float64),
                np.asarray(shaded.faces, dtype=np.int64))
    except Exception as exc:                       # pas de moteur de graphe : plat
        print("    normales par facette (%s)" % type(exc).__name__)
        v = mesh.vertices[mesh.faces].reshape(-1, 3)
        n = np.repeat(mesh.face_normals, 3, axis=0)
        f = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
        return v, n, f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="clone de github.com/elpimous/ylo-2")
    ap.add_argument("--out", default="assets", help="dossier de sortie")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    blobs, index, cursor = [], {}, 0

    for name, (rel, budget) in PARTS.items():
        path = os.path.join(args.repo, rel)
        if not os.path.exists(path):
            print("  %-12s absent : %s" % (name, rel))
            continue
        mesh = load_mesh(path)
        before = len(mesh.faces)
        mesh = decimate(mesh, budget)
        verts, norms, faces = split_normals(mesh)

        pos = np.asarray(verts, dtype=np.float32).ravel()
        nrm = np.asarray(norms, dtype=np.float32).ravel()
        idx = np.asarray(faces, dtype=np.uint32).ravel()

        entry = {
            "source": rel,
            "tris": int(len(faces)),
            "trisSource": int(before),
            "vertices": int(len(verts)),
            "pos": [cursor, int(pos.nbytes)],
            "nrm": [cursor + int(pos.nbytes), int(nrm.nbytes)],
            "idx": [cursor + int(pos.nbytes) + int(nrm.nbytes), int(idx.nbytes)],
            "bounds": [[float(v) for v in verts.min(axis=0)],
                       [float(v) for v in verts.max(axis=0)]],
        }
        blobs += [pos.tobytes(), nrm.tobytes(), idx.tobytes()]
        cursor = entry["idx"][0] + entry["idx"][1]
        index[name] = entry
        print("  %-12s %6d -> %6d tris, %6d sommets" % (name, before, len(faces), len(verts)))

    blob = b"".join(blobs)
    bin_path = os.path.join(args.out, "ylo2-geometry.bin")
    json_path = os.path.join(args.out, "ylo2-geometry.json")
    with open(bin_path, "wb") as fh:
        fh.write(blob)
    with open(json_path, "w") as fh:
        json.dump({"crease": CREASE_DEG, "bytes": len(blob), "parts": index}, fh, indent=1)

    print("\n%s : %.2f Mo" % (bin_path, len(blob) / 1e6))
    print("%s : %d pièces" % (json_path, len(index)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
