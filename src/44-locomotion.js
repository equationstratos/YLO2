/* =====================================================================
   YLO-2 — locomotion souple et figures
   Deux couches par-dessus le générateur d'allure de base :

   · style « souple » : placement de pied à la Raibert, vol en Hermite
     (pas de raclage au poser), compliance d'appui, report de masse,
     inclinaison en virage, lissage des consignes, respiration à l'arrêt.
     Ce sont les ingrédients habituels des quadrupèdes type Unitree Go2 ;
     ici tout est cinématique, sans dynamique.

   · figures : salto arrière avec envol balistique réel (z et rotation
     imposés par la gravité, pas par une courbe arbitraire).
   ===================================================================== */
(function (Y) {
  "use strict";
  const K = Y.K;
  const G_ACC = 9.81;

  function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
  function smooth(s) { return s * s * (3 - 2 * s); }
  function smoother(s) { return s * s * s * (s * (s * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* =====================================================================
     1. Style souple
     ===================================================================== */
  const NAT = {
    accelLin: 0.45,        // m/s²  montée en vitesse
    accelAng: 2.0,         // rad/s²
    raibert: 0.06,         // gain de rattrapage sur l'erreur de vitesse
    retraction: 1.18,      // tangente de fin de vol : le pied recule avant de poser
    dip: 0.011,            // enfoncement de caisse en milieu d'appui (m)
    sway: 0.014,           // report latéral de masse (m)
    bank: 0.55,            // inclinaison en virage (fraction de l'angle idéal)
    pitchAccel: 0.16,      // piqué proportionnel à l'accélération
    breath: 0.004,         // respiration à l'arrêt (m)
    trotAbove: 0.09,       // seuil walk -> trot (m/s)
    walkBelow: 0.06        // hystérésis trot -> walk
  };

  const nat = {
    vx: 0, vy: 0, wz: 0,             // vitesses réellement suivies (lissées)
    ax: 0,                            // accélération longitudinale filtrée
    lift: {},                         // position du pied au décollage, par patte
    auto: true,                       // choix d'allure selon la vitesse
    duty: 0.5, stance: 0.25,          // paramètres d'allure fondus
    off: {}                           // décalages de phase fondus
  };

  Y.LEGS.forEach(function (L) { nat.lift[L.id] = null; nat.off[L.id] = 0; });

  /** Fond les paramètres d'allure : un changement sec ferait sauter les pattes. */
  function blendGait(g, dt) {
    const k = Math.min(1, dt * 3.5);
    nat.duty = lerp(nat.duty, g.duty, k);
    nat.stance = lerp(nat.stance, g.stance, k);
    Y.LEGS.forEach(function (L) {
      const target = g.off[L.id];
      let d = target - nat.off[L.id];
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;    // chemin le plus court
      nat.off[L.id] = (nat.off[L.id] + d * k + 1) % 1;
    });
  }

  function approach(current, target, rate, dt) {
    const step = rate * dt;
    if (Math.abs(target - current) <= step) return target;
    return current + Math.sign(target - current) * step;
  }

  /** Choix d'allure : marche à basse vitesse, trot au-dessus. */
  function autoGait(state) {
    if (!nat.auto) return;
    if (state.gait === "pace" || state.gait === "bound") return;   // choix explicite
    const speed = Math.hypot(nat.vx, nat.vy) + Math.abs(nat.wz) * 0.12;
    if (state.gait !== "trot" && speed > NAT.trotAbove) state.gait = "trot";
    else if (state.gait === "trot" && speed < NAT.walkBelow) state.gait = "walk";
    else if (state.gait === "stand" && speed > 0.005) state.gait = "walk";
    if (speed < 0.004 && state.gait !== "stand") state.gait = "stand";
  }

  /**
   * Trajectoire de vol : Hermite cubique dont les tangentes prolongent la
   * vitesse d'appui. Le pied quitte et retrouve le sol à la vitesse du sol,
   * ce qui supprime le raclage et donne l'aspect « posé » du pas.
   */
  function swingXY(p0, p1, tangent, s) {
    const h00 = 2 * s * s * s - 3 * s * s + 1;
    const h10 = s * s * s - 2 * s * s + s;
    const h01 = -2 * s * s * s + 3 * s * s;
    const h11 = s * s * s - s * s;
    return h00 * p0 + h10 * tangent + h01 * p1 + h11 * tangent * NAT.retraction;
  }

  /** Profil vertical asymétrique : montée vive, apex avancé, poser amorti. */
  function swingZ(s) {
    const e = Math.pow(clamp(s, 0, 1), 0.82);
    return Math.sin(Math.PI * e) * (1 - 0.18 * s);
  }

  /**
   * Passe du repère « horizon » (aligné sur le sol, tourné du lacet) au
   * repère tronc : sans ça, le tangage et le roulis enfoncent les pieds
   * dans le sol au lieu de les laisser plantés.
   */
  function levelToBody(v, roll, pitch) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [
      cp * v[0] - sp * v[2],
      sp * sr * v[0] + cr * v[1] + cp * sr * v[2],
      sp * cr * v[0] - sr * v[1] + cp * cr * v[2]
    ];
  }

  function stepNatural(dt, state) {
    const cmdVx = state.vx, cmdVy = state.vy, cmdWz = state.wz;
    const prevVx = nat.vx;

    nat.vx = approach(nat.vx, cmdVx, NAT.accelLin, dt);
    nat.vy = approach(nat.vy, cmdVy, NAT.accelLin, dt);
    nat.wz = approach(nat.wz, cmdWz, NAT.accelAng, dt);
    nat.ax = lerp(nat.ax, (nat.vx - prevVx) / Math.max(dt, 1e-3), Math.min(1, dt * 6));

    autoGait(state);
    const g = Y.GAITS[state.gait];
    blendGait(g, dt);
    const moving = state.gait !== "stand";
    const duty = moving ? nat.duty : 1;
    const stance = nat.stance;
    const cycle = stance / Math.max(duty, 0.05);

    if (moving) {
      state.phase = (state.phase + dt / cycle) % 1;
      state.yaw += nat.wz * dt;
      state.px += (nat.vx * Math.cos(state.yaw) - nat.vy * Math.sin(state.yaw)) * dt;
      state.py += (nat.vx * Math.sin(state.yaw) + nat.vy * Math.cos(state.yaw)) * dt;
    }

    // --- attitude de caisse -------------------------------------------
    let stanceLoad = 0;
    Y.LEGS.forEach(function (L) {
      const ph = (state.phase + nat.off[L.id]) % 1;
      if (!moving || ph < duty) stanceLoad += Math.sin(Math.PI * clamp(ph / duty, 0, 1));
    });
    stanceLoad /= 4;

    const breath = moving ? 0 : Math.sin(state.t * 1.6) * NAT.breath;
    const dip = moving ? NAT.dip * stanceLoad : 0;
    state.z = state.height - dip + breath;

    // report de masse : la caisse glisse vers les appuis, les pieds restent au sol
    const swayPhase = state.phase * Math.PI * 2 + (state.gait === "trot" ? 0 : Math.PI / 2);
    state.sway = moving ? Math.sin(swayPhase) * NAT.sway * (state.gait === "trot" ? 0.45 : 1) : 0;

    // inclinaison en virage : on penche vers l'intérieur, comme un animal
    const bankIdeal = Math.atan2(nat.vx * nat.wz, G_ACC);
    state.roll = lerp(state.roll, -bankIdeal * NAT.bank + state.sway * 0.9, Math.min(1, dt * 5));
    const pitchGait = moving ? Math.sin(state.phase * Math.PI * 4 + 1.1) * 0.012 : 0;
    state.pitch = lerp(state.pitch, clamp(nat.ax, -1.2, 1.2) * NAT.pitchAccel + pitchGait,
      Math.min(1, dt * 6));

    // --- pieds ---------------------------------------------------------
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      // l'appui reste immobile : on retranche le report de masse de la cible
      const nx = L.x, ny = L.y + L.m * K.abadPlane - state.sway;

      // vitesse du pied au sol : v + ω × r
      const vfx = nat.vx - nat.wz * ny;
      const vfy = nat.vy + nat.wz * nx;
      const sweepX = vfx * stance, sweepY = vfy * stance;

      // placement à la Raibert : demi-course + rattrapage de l'erreur de vitesse
      const errX = (nat.vx - cmdVx) * NAT.raibert;
      const errY = (nat.vy - cmdVy) * NAT.raibert;

      const ph = (state.phase + nat.off[L.id]) % 1;
      let fx = nx, fy = ny, fz = -state.z, contact = true;

      if (moving) {
        if (ph < duty) {                                    // appui
          const s = ph / duty;
          fx = nx + sweepX * (0.5 - s);
          fy = ny + sweepY * (0.5 - s);
          nat.lift[L.id] = [fx, fy];                        // mémorise le décollage
        } else {                                            // vol
          const s = (ph - duty) / (1 - duty);
          const p0 = nat.lift[L.id] || [nx - sweepX * 0.5, ny - sweepY * 0.5];
          const tdX = nx + sweepX * 0.5 + errX;
          const tdY = ny + sweepY * 0.5 + errY;
          const tangentX = sweepX * (1 - duty) / duty;
          const tangentY = sweepY * (1 - duty) / duty;
          fx = swingXY(p0[0], tdX, tangentX, s);
          fy = swingXY(p0[1], tdY, tangentY, s);
          fz = -state.z + state.swing * swingZ(s);
          contact = false;
        }
      }

      const target = levelToBody([fx, fy, fz], state.roll, state.pitch);
      n.q = Y.Motion.ik(L, target[0], target[1], target[2]);
      n.contact = contact;
      n.phase = ph;
    });
  }

  /* =====================================================================
     2. Figures — salto arrière
     ===================================================================== */

  // Poses de référence, en angles articulaires (haa, hfe, kfe) par patte
  const POSE = {
    tuck:   { front: [0, 1.55, -2.55], hind: [0, 1.35, -2.60] },   // groupé en l'air
    reach:  { front: [0, 0.55, -1.45], hind: [0, 0.85, -1.70] },   // jambes tendues vers le sol
    launch: { front: [0, 0.35, -0.95], hind: [0, 0.30, -0.85] }    // extension de poussée
  };

  function poseFor(L, pose) {
    return (L.f > 0 ? pose.front : pose.hind).slice();
  }

  const flip = {
    name: "backflip",
    t: 0,
    // découpage : accroupi, armé, poussée, vol balistique, réception, retour
    crouch: 0.34, load: 0.10, push: 0.19, land: 0.22, recover: 0.42,
    takeoffZ: 0.32, crouchZ: 0.165, absorbZ: 0.185,
    vz: 0, flight: 0,
    travel: -0.10                       // léger recul pendant la figure
  };

  flip.vz = 2.95;                                    // m/s à la poussée
  flip.flight = 2 * flip.vz / G_ACC;                 // ≈ 0,62 s de vol
  flip.duration = flip.crouch + flip.load + flip.push + flip.flight + flip.land + flip.recover;

  function stepBackflip(dt, state) {
    flip.t += dt;
    const t = flip.t;
    let phase = "";

    const tCrouch = flip.crouch;
    const tLoad = tCrouch + flip.load;
    const tPush = tLoad + flip.push;
    const tFly = tPush + flip.flight;
    const tLand = tFly + flip.land;

    // Interpolations de pose à vitesse bornée : on part de la pose mesurée au
    // décollage, sinon le passage appui -> groupé impose des dizaines de rad/s.
    const poseFrom = function (start, pose, k) {
      Y.LEGS.forEach(function (L, li) {
        const n = Y.Robot.legs[L.id];
        const target = poseFor(L, pose);
        n.q = [0, 1, 2].map(function (i) { return lerp(start[li * 3 + i], target[i], k); });
        n.contact = false;
      });
    };

    const poseMix = function (a, b, k) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        const pa = poseFor(L, a), pb = poseFor(L, b);
        n.q = [0, 1, 2].map(function (i) { return lerp(pa[i], pb[i], k); });
        n.contact = false;
      });
    };

    const poseToGround = function (pose, k, height, shiftX) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        const pa = poseFor(L, pose);
        const pb = Y.Motion.ik(L, L.x + shiftX, L.y + L.m * K.abadPlane, -height);
        n.q = [0, 1, 2].map(function (i) { return lerp(pa[i], pb[i], k); });
        n.contact = k > 0.5;
      });
    };

    const groundPose = function (height, shiftX) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        const fx = L.x + (shiftX || 0);
        const fy = L.y + L.m * K.abadPlane;
        n.q = Y.Motion.ik(L, fx, fy, -height);
        n.contact = true;
      });
    };

    if (t < tCrouch) {                                  // 1. accroupissement
      phase = "armement";
      const s = smooth(t / tCrouch);
      state.z = lerp(state.height, flip.crouchZ, s);
      state.pitch = lerp(0, 0.06, s);
      groundPose(state.z, lerp(0, 0.02, s));
    } else if (t < tLoad) {                             // 2. bascule arrière
      phase = "bascule";
      const s = smooth((t - tCrouch) / flip.load);
      state.z = flip.crouchZ;
      state.pitch = lerp(0.06, -0.10, s);
      groundPose(state.z, lerp(0.02, -0.01, s));
    } else if (t < tPush) {                             // 3. poussée
      phase = "poussée";
      const s = (t - tLoad) / flip.push;
      state.z = lerp(flip.crouchZ, flip.takeoffZ, smooth(s));
      state.pitch = lerp(-0.10, -0.55, smooth(s));
      state.px += flip.travel * dt * 0.5;
      groundPose(Math.min(state.z, K.L1 + K.L2 - 0.02), -0.01);
      flip.takeoffQ = null;
    } else if (t < tFly) {                              // 4. vol balistique
      phase = "vol";
      const s = (t - tPush) / flip.flight;
      const tf = t - tPush;
      state.z = flip.takeoffZ + flip.vz * tf - 0.5 * G_ACC * tf * tf;
      state.pitch = -0.55 - (2 * Math.PI - 0.55) * smoother(s);      // tour complet
      state.px += flip.travel * dt / flip.flight;
      if (!flip.takeoffQ) {
        flip.takeoffQ = Y.LEGS.reduce(function (acc, L) {
          return acc.concat(Y.Robot.legs[L.id].q);
        }, []);
      }
      if (s < 0.45) poseFrom(flip.takeoffQ, POSE.tuck, smooth(s / 0.45));   // groupé
      else poseMix(POSE.tuck, POSE.reach, smooth((s - 0.45) / 0.55));       // ouverture
    } else if (t < tLand) {                             // 5. réception amortie
      phase = "réception";
      // le tour est bouclé : -2π est la même orientation que 0, on repart de 0
      // pour ne pas dérouler la rotation à l'envers pendant la réception
      const s = smooth((t - tFly) / flip.land);
      state.z = lerp(flip.takeoffZ, flip.absorbZ, s);
      state.pitch = lerp(0, 0.12, s);                 // encaisse, nez qui pique
      poseToGround(POSE.reach, s, state.z, 0.015);
    } else {                                            // 6. retour en station
      phase = "stabilisation";
      const s = smooth((t - tLand) / flip.recover);
      // léger rebond amorti avant de retrouver la hauteur de consigne
      const bounce = Math.sin(Math.PI * s * 2) * 0.012 * (1 - s);
      state.z = lerp(flip.absorbZ, state.height, s) + bounce;
      state.pitch = lerp(0.12, 0, s) + Math.sin(Math.PI * s * 3) * 0.02 * (1 - s);
      groundPose(state.z, lerp(0.015, 0, s));
    }

    state.roll = 0;
    Y.Stunt.phase = phase;
    Y.Stunt.progress = clamp(t / flip.duration, 0, 1);

    if (t >= flip.duration) {
      state.pitch = 0;
      state.z = state.height;
      Y.Stunt.stop();
    }
  }

  Y.Stunt = {
    active: null,
    phase: "",
    progress: 0,
    listeners: [],

    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () {
      const self = this;
      this.listeners.forEach(function (fn) { fn(self); });
    },

    start: function (name) {
      if (name !== "backflip") return false;
      flip.t = 0;
      flip.takeoffQ = null;
      this.active = name;
      this.phase = "armement";
      this.progress = 0;
      this.emit();
      return true;
    },

    stop: function () {
      this.active = null;
      this.phase = "";
      this.progress = 0;
      this.emit();
    },

    duration: function () { return flip.duration; },

    step: function (dt, state) {
      if (this.active !== "backflip") return false;
      stepBackflip(dt, state);
      return true;
    }
  };

  Y.Natural = {
    params: NAT,
    state: nat,
    step: stepNatural,
    reset: function () {
      nat.vx = nat.vy = nat.wz = nat.ax = 0;
      Y.LEGS.forEach(function (L) { nat.lift[L.id] = null; nat.off[L.id] = 0; });

  /** Fond les paramètres d'allure : un changement sec ferait sauter les pattes. */
  function blendGait(g, dt) {
    const k = Math.min(1, dt * 3.5);
    nat.duty = lerp(nat.duty, g.duty, k);
    nat.stance = lerp(nat.stance, g.stance, k);
    Y.LEGS.forEach(function (L) {
      const target = g.off[L.id];
      let d = target - nat.off[L.id];
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;    // chemin le plus court
      nat.off[L.id] = (nat.off[L.id] + d * k + 1) % 1;
    });
  }
    },
    setAuto: function (on) { nat.auto = !!on; }
  };
})(window.YLO);
