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
import math
import os
import struct
import sys

import numpy as np

# nom logique -> (chemin dans le dépôt, budget de triangles ; 0 = tel quel)
PARTS = {
    "trunk":       ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_body.dae", 0),
    "cover":       ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_cover.dae", 0),
    "abad_motors": ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_abad_motors.dae", 0),
    "accessories": ("champ_for_ylo2/ylo2_description/meshes/body/textured/accessories.dae", 0),
    "battery":     ("champ_for_ylo2/ylo2_description/meshes/body/battery.stl", 0),
    "d435":        ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_d435_textured.dae", 0),
    "t265":        ("champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_t265_textured.dae", 0),
    "hip":         ("champ_for_ylo2/ylo2_description/meshes/leg/textured/ylo2texturedhip.dae", 0),
    "upper_leg":   ("champ_for_ylo2/ylo2_description/meshes/leg/textured/ylo2_textured_upper_leg.dae", 0),
    "lower_leg":   ("champ_for_ylo2/ylo2_description/meshes/leg/textured/lower_leg.dae", 0),
    "foot":        ("champ_for_ylo2/ylo2_description/meshes/leg/textured/fl_foot.dae", 0),
    "lidar":       ("Wolf_for_ylo2/wolf_descriptions/ylo2_description/meshes/body/textured/Rp_lidar_A2.dae", 0),
}

CREASE_DEG = 35.0


def load_mesh(path):
    import trimesh
    mesh = trimesh.load(path, force="mesh", process=True)
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("maillage vide")
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())    # triangles plats
    mesh.update_faces(mesh.unique_faces())           # faces en double : z-fighting
    mesh.remove_unreferenced_vertices()
    if not mesh.is_winding_consistent:
        mesh.fix_normals()
    return mesh


def decimate(mesh, budget):
    """Réduction optionnelle. À utiliser avec prudence : la simplification
    replie les coques minces sur elles-mêmes (les éclats vus sur la cuisse),
    d'où la valeur 0 par défaut."""
    if not budget or len(mesh.faces) <= budget:
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


def crease_normals(mesh, angle_deg=CREASE_DEG):
    """Normales par coin, lissées sauf au-delà de l'angle de cassure.

    trimesh.smooth_shaded regroupe par facettes coplanaires : sur les
    cylindres usinés du robot, ça laisse des coins entiers mal orientés
    (les éclats visibles sur les moteurs d'abduction). On calcule donc la
    normale coin par coin : moyenne pondérée par l'angle au sommet des
    faces voisines dont l'orientation reste dans le cône autorisé.
    """
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    fnorm = np.asarray(mesh.face_normals, dtype=np.float64)

    # angle au sommet de chaque coin, pour pondérer la moyenne
    tri = verts[faces]
    corner_w = np.empty((len(faces), 3))
    for k in range(3):
        a = tri[:, (k + 1) % 3] - tri[:, k]
        b = tri[:, (k + 2) % 3] - tri[:, k]
        na = np.linalg.norm(a, axis=1) + 1e-12
        nb = np.linalg.norm(b, axis=1) + 1e-12
        cos = np.clip(np.einsum("ij,ij->i", a, b) / (na * nb), -1.0, 1.0)
        corner_w[:, k] = np.arccos(cos)

    # faces incidentes à chaque sommet
    order = np.argsort(faces.ravel(), kind="stable")
    vert_of_corner = faces.ravel()[order]
    face_of_corner = np.repeat(np.arange(len(faces)), 3)[order]
    starts = np.searchsorted(vert_of_corner, np.arange(len(verts)), side="left")
    ends = np.searchsorted(vert_of_corner, np.arange(len(verts)), side="right")

    limit = math.cos(math.radians(angle_deg))
    normals = np.zeros((len(faces), 3, 3))
    for v in range(len(verts)):
        lo, hi = starts[v], ends[v]
        if lo == hi:
            continue
        neigh = face_of_corner[lo:hi]
        nn = fnorm[neigh]
        weights = np.empty(len(neigh))
        for i, f in enumerate(neigh):
            weights[i] = corner_w[f, int(np.where(faces[f] == v)[0][0])]
        # pour chaque face incidente, moyenne des voisines assez alignées
        dots = nn @ nn.T
        mask = dots >= limit
        acc = (mask * weights[None, :]) @ nn
        lens = np.linalg.norm(acc, axis=1)
        acc[lens < 1e-9] = nn[lens < 1e-9]
        lens = np.linalg.norm(acc, axis=1) + 1e-12
        acc /= lens[:, None]
        for i, f in enumerate(neigh):
            k = int(np.where(faces[f] == v)[0][0])
            normals[f, k] = acc[i]

    # index (sommet, normale arrondie) -> sommet de sortie
    quant = np.round(normals.reshape(-1, 3) * 1000).astype(np.int32)
    keys = np.concatenate([faces.reshape(-1, 1), quant], axis=1)
    view = np.ascontiguousarray(keys).view(
        np.dtype((np.void, keys.dtype.itemsize * keys.shape[1])))
    _, first, inverse = np.unique(view.ravel(), return_index=True, return_inverse=True)
    out_verts = verts[faces.ravel()[first]]
    out_norms = normals.reshape(-1, 3)[first]
    out_faces = inverse.reshape(-1, 3).astype(np.int64)
    return out_verts, out_norms, out_faces


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="clone de github.com/elpimous/ylo-2")
    ap.add_argument("--out", default="assets", help="dossier de sortie")
    ap.add_argument("--max-tris", type=int, default=0,
                    help="plafond de triangles par pièce (0 = aucune décimation)")
    ap.add_argument("--crease", type=float, default=CREASE_DEG,
                    help="angle de cassure des normales, en degrés")
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
        mesh = decimate(mesh, args.max_tris or budget)
        verts, norms, faces = crease_normals(mesh, args.crease)

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
