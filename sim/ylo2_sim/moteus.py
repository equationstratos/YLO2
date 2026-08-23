"""Vue « bus CAN » de la commande : répartition des 12 moteus sur la PCAN-M.2.

Le driver du dépôt (moteus_driver/src/YloTwoPcanToMoteus.cpp) ouvre quatre
ports PCAN_PCIBUS1..4 et adresse trois contrôleurs par port, en mode position.
Ce module reproduit ce plan d'adressage et estime la charge de bus ; il ne
parle à aucun matériel.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Sequence

from .model import DEFAULT, Model

# CAN-FD : arbitrage 1 Mbit/s, données 5 Mbit/s (réglage courant chez mjbots)
ARBITRATION_BITS = 40          # en-tête + arbitrage, ordre de grandeur
DATA_RATE = 5_000_000
ARB_RATE = 1_000_000
QUERY_PAYLOAD = 16             # octets d'une requête position + interrogation
REPLY_PAYLOAD = 24             # octets d'une réponse position/vitesse/couple


@dataclass(frozen=True)
class Address:
    joint: str
    port: int                  # 1..4, PCAN_PCIBUS<port>
    can_id: int                # 1..3 sur ce port
    sign: int                  # sens de rotation vu du moteur
    reduction: float           # rapport global articulation -> rotor


def build_map(model: Model = DEFAULT) -> Dict[str, Address]:
    """Un port par patte, trois contrôleurs par port."""
    table: Dict[str, Address] = {}
    for port, leg in enumerate(model.legs, start=1):
        for can_id, axis in enumerate(("haa", "hfe", "kfe"), start=1):
            joint = f"{leg.name}_{axis}"
            reduction = model.gear_motor * (model.gear_knee if axis == "kfe" else 1.0)
            table[joint] = Address(joint, port, can_id, leg.mirror if axis != "hfe" else 1,
                                   reduction)
    return table


MAP = build_map()


def to_revolutions(joint: str, angle: float, table: Dict[str, Address] = None) -> float:
    """Angle articulaire (rad) -> consigne position moteus (tours rotor)."""
    addr = (table or MAP)[joint]
    return addr.sign * angle / (2.0 * math.pi) * addr.reduction


def bus_load(rate_hz: float, joints_per_port: int = 3) -> Dict[str, float]:
    """Estimation de la charge d'un port CAN-FD pour une cadence donnée.

    Une itération = une trame de consigne + une réponse par moteur du port.
    """
    per_exchange_bits = 2 * ARBITRATION_BITS + (QUERY_PAYLOAD + REPLY_PAYLOAD) * 8
    arb_time = 2 * ARBITRATION_BITS / ARB_RATE
    data_time = (QUERY_PAYLOAD + REPLY_PAYLOAD) * 8 / DATA_RATE
    per_exchange_s = arb_time + data_time
    frames = rate_hz * joints_per_port * 2
    load = rate_hz * joints_per_port * per_exchange_s
    return {
        "frames_per_second": frames,
        "bits_per_exchange": per_exchange_bits,
        "microseconds_per_exchange": per_exchange_s * 1e6,
        "load_ratio": load,
    }


def report(rate_hz: float, table: Dict[str, Address] = None) -> Dict[str, object]:
    table = table or MAP
    ports: Dict[int, List[str]] = {}
    for addr in table.values():
        ports.setdefault(addr.port, []).append(addr.joint)
    per_port = {p: sorted(js) for p, js in sorted(ports.items())}
    load = bus_load(rate_hz)
    return {"rate_hz": rate_hz, "ports": per_port, "bus": load}


def format_report(rate_hz: float, table: Dict[str, Address] = None) -> str:
    data = report(rate_hz, table)
    lines = [f"Cadence de commande : {rate_hz:.0f} Hz"]
    for port, joints in data["ports"].items():
        lines.append(f"  PCAN_PCIBUS{port} : " + ", ".join(joints))
    bus = data["bus"]
    lines.append(
        "  Estimation par port : %.0f trames/s, %.1f µs par échange, charge ~%.1f %%"
        % (bus["frames_per_second"], bus["microseconds_per_exchange"], bus["load_ratio"] * 100)
    )
    return "\n".join(lines)
