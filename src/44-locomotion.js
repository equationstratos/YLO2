/* =====================================================================
   YLO-2 — styles de locomotion et figures

   Trois styles, empilés sur le générateur d'allure de base :
     · brut   — le générateur nu de gait.yaml, sans compensation
     · souple — placement à la Raibert, vol en Hermite, compliance,
                report de masse, compensation d'assiette
     · félin  — même socle, réglé sur une marche de félin : voie étroite,
                triple appui, report de masse anticipé, balancement du
                tronc, poser lent, cadence non métronomique

   Trois figures : salto arrière, double salto, 540 McTwist. Le vol est
   balistique dans les trois cas — hauteur et rotations sont imposées par
   la gravité et la vitesse de poussée, pas par une courbe décorative.
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
     1. Profils de locomotion
     ===================================================================== */
  const PROFILES = {
    souple: {
      accelLin: 0.45, accelAng: 2.0,
      raibert: 0.06, retraction: 1.18,
      dip: 0.011, sway: 0.014, swayLead: 0.00,
      bank: 0.55, pitchAccel: 0.16, pitchGait: 0.012, breath: 0.004,
      trotAbove: 0.09, walkBelow: 0.06, blend: 3.5,
      track: 1.00, dutyBias: 0.00, swingScale: 1.00, cycleScale: 1.00,
      yawWag: 0.000, jitter: 0.000, heightBias: 1.00, hindReach: 0.000,
      settle: 0.00
    },
    felin: {
      // le chat marche bas, pose loin, garde trois appuis et se balance
      accelLin: 0.32, accelAng: 1.5,
      raibert: 0.05, retraction: 1.30,
      dip: 0.016, sway: 0.024, swayLead: 0.16,
      bank: 0.80, pitchAccel: 0.10, pitchGait: 0.004, breath: 0.005,
      trotAbove: 0.17, walkBelow: 0.12, blend: 1.8,
      track: 0.55, dutyBias: 0.05, swingScale: 0.80, cycleScale: 1.35,
      yawWag: 0.020, jitter: 0.014, heightBias: 0.93, hindReach: 0.022,
      settle: 0.14
    }
  };

  const nat = {
    profile: PROFILES.souple,
    vx: 0, vy: 0, wz: 0,             // vitesses réellement suivies (lissées)
    ax: 0,                            // accélération longitudinale filtrée
    lift: {},                         // position du pied au décollage
    jit: {}, lastPh: {},              // cadence légèrement irrégulière
    auto: true,                       // choix d'allure selon la vitesse
    duty: 0.5, stance: 0.25,          // paramètres d'allure fondus
    trotMix: 1,                       // 1 = trot, 0 = allure latérale (fondu)
    // réglages de posture fondus : changer de style ne doit pas téléporter les pieds
    track: 1, heightBias: 1, hindReach: 0, swingScale: 1,
    off: {}
  };

  Y.LEGS.forEach(function (L) {
    nat.lift[L.id] = null; nat.off[L.id] = 0; nat.jit[L.id] = 0; nat.lastPh[L.id] = 0;
  });

  function approach(current, target, rate, dt) {
    const step = rate * dt;
    if (Math.abs(target - current) <= step) return target;
    return current + Math.sign(target - current) * step;
  }

  /** Fond les paramètres d'allure : un changement sec ferait sauter les pattes. */
  function blendGait(g, dt) {
    const k = Math.min(1, dt * nat.profile.blend);
    nat.duty = lerp(nat.duty, g.duty, k);
    nat.stance = lerp(nat.stance, g.stance, k);
    // le report de masse dépend de l'allure : on le fond aussi, sinon le
    // passage marche -> trot déplace les appuis d'un coup
    nat.trotMix = lerp(nat.trotMix, g.name === "trot" || g.name === "bound" ? 1 : 0, k);
    Y.LEGS.forEach(function (L) {
      let d = g.off[L.id] - nat.off[L.id];
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;    // chemin le plus court
      nat.off[L.id] = (nat.off[L.id] + d * k + 1) % 1;
    });
  }

  /** Choix d'allure : marche à basse vitesse, trot au-dessus. */
  function autoGait(state) {
    if (!nat.auto) return;
    if (state.gait === "pace" || state.gait === "bound") return;
    const p = nat.profile;
    const speed = Math.hypot(nat.vx, nat.vy) + Math.abs(nat.wz) * 0.12;
    if (state.gait !== "trot" && speed > p.trotAbove) state.gait = "trot";
    else if (state.gait === "trot" && speed < p.walkBelow) state.gait = "walk";
    else if (state.gait === "stand" && speed > 0.005) state.gait = "walk";
    if (speed < 0.004 && state.gait !== "stand") state.gait = "stand";
  }

  /**
   * Trajectoire de vol : Hermite cubique dont les tangentes prolongent la
   * vitesse d'appui. Le pied quitte et retrouve le sol à la vitesse du sol,
   * ce qui supprime le raclage et donne l'aspect « posé » du pas.
   */
  function swingXY(p0, p1, tangent, s, retraction) {
    const h00 = 2 * s * s * s - 3 * s * s + 1;
    const h10 = s * s * s - 2 * s * s + s;
    const h01 = -2 * s * s * s + 3 * s * s;
    const h11 = s * s * s - s * s;
    return h00 * p0 + h10 * tangent + h01 * p1 + h11 * tangent * retraction;
  }

  /** Profil vertical : montée vive, apex avancé, poser amorti. */
  function swingZ(s, settle) {
    const e = Math.pow(clamp(s, 0, 1), 0.82);
    const base = Math.sin(Math.PI * e) * (1 - 0.18 * s);
    if (!settle) return base;
    // le félin approche le sol puis dépose la patte : on aplatit la fin du vol
    const damp = s > 1 - settle ? smooth((1 - s) / settle) : 1;
    return base * damp;
  }

  /**
   * Repère « horizon » (aligné sur le sol) vers repère tronc : sans ça, le
   * tangage et le roulis enfoncent les pieds dans le sol au lieu de les
   * laisser plantés. Le lacet de balancement est compensé de la même façon.
   */
  function levelToBody(v, roll, pitch, wag) {
    const cw = Math.cos(wag), sw = Math.sin(wag);
    const x0 = cw * v[0] + sw * v[1];
    const y0 = -sw * v[0] + cw * v[1];
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [
      cp * x0 - sp * v[2],
      sp * sr * x0 + cr * y0 + cp * sr * v[2],
      sp * cr * x0 - sr * y0 + cp * cr * v[2]
    ];
  }

  function stepNatural(dt, state) {
    const p = nat.profile;
    const cmdVx = state.vx, cmdVy = state.vy, cmdWz = state.wz;
    const prevVx = nat.vx;

    nat.vx = approach(nat.vx, cmdVx, p.accelLin, dt);
    nat.vy = approach(nat.vy, cmdVy, p.accelLin, dt);
    nat.wz = approach(nat.wz, cmdWz, p.accelAng, dt);
    nat.ax = lerp(nat.ax, (nat.vx - prevVx) / Math.max(dt, 1e-3), Math.min(1, dt * 6));

    // fondu de posture entre profils (voie, hauteur, portée arrière, garde)
    const kp = Math.min(1, dt * 2.5);
    nat.track = lerp(nat.track, p.track, kp);
    nat.heightBias = lerp(nat.heightBias, p.heightBias, kp);
    nat.hindReach = lerp(nat.hindReach, p.hindReach, kp);
    nat.swingScale = lerp(nat.swingScale, p.swingScale, kp);

    autoGait(state);
    const g = Y.GAITS[state.gait];
    blendGait(g, dt);

    const moving = state.gait !== "stand";
    const duty = moving ? clamp(nat.duty + p.dutyBias, 0.4, 0.80) : 1;
    const stance = nat.stance * p.cycleScale;
    const cycle = stance / Math.max(duty, 0.05);
    const height = state.height * nat.heightBias;

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

    const breath = moving ? 0 : Math.sin(state.t * 1.6) * p.breath;
    state.z = height - (moving ? p.dip * stanceLoad : 0) + breath;

    // report de masse : la caisse glisse vers les appuis, en anticipant le pas
    const swayPhase = (state.phase + p.swayLead) * Math.PI * 2 +
      lerp(Math.PI / 2, 0, nat.trotMix);
    state.sway = moving ? Math.sin(swayPhase) * p.sway * lerp(1, 0.45, nat.trotMix) : 0;

    // balancement du tronc en lacet : ce que ferait la colonne d'un félin
    state.yawWag = moving ? -Math.sin(swayPhase) * p.yawWag : 0;

    const bankIdeal = Math.atan2(nat.vx * nat.wz, G_ACC);
    state.roll = lerp(state.roll, -bankIdeal * p.bank + state.sway * 0.9, Math.min(1, dt * 5));
    const pitchGait = moving ? Math.sin(state.phase * Math.PI * 4 + 1.1) * p.pitchGait : 0;
    state.pitch = lerp(state.pitch, clamp(nat.ax, -1.2, 1.2) * p.pitchAccel + pitchGait,
      Math.min(1, dt * 6));

    // --- pieds ---------------------------------------------------------
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];

      // voie : le félin rapproche ses appuis de l'axe du corps
      const nx = L.x + (L.f < 0 ? nat.hindReach : 0);
      const ny = (L.y + L.m * K.abadPlane) * nat.track - state.sway;

      const vfx = nat.vx - nat.wz * ny;                  // v + ω × r
      const vfy = nat.vy + nat.wz * nx;
      const sweepX = vfx * stance, sweepY = vfy * stance;
      const errX = (nat.vx - cmdVx) * p.raibert;
      const errY = (nat.vy - cmdVy) * p.raibert;

      // cadence légèrement irrégulière, renouvelée à chaque cycle de la patte
      let ph = (state.phase + nat.off[L.id] + nat.jit[L.id]) % 1;
      if (ph < nat.lastPh[L.id]) nat.jit[L.id] = (Math.random() - 0.5) * p.jitter;
      nat.lastPh[L.id] = ph;

      let fx = nx, fy = ny, fz = -state.z, contact = true;

      if (moving) {
        if (ph < duty) {                                  // appui
          const s = ph / duty;
          fx = nx + sweepX * (0.5 - s);
          fy = ny + sweepY * (0.5 - s);
          nat.lift[L.id] = [fx, fy];
        } else {                                          // vol
          const s = (ph - duty) / (1 - duty);
          const p0 = nat.lift[L.id] || [nx - sweepX * 0.5, ny - sweepY * 0.5];
          const tanX = sweepX * (1 - duty) / duty;
          const tanY = sweepY * (1 - duty) / duty;
          fx = swingXY(p0[0], nx + sweepX * 0.5 + errX, tanX, s, p.retraction);
          fy = swingXY(p0[1], ny + sweepY * 0.5 + errY, tanY, s, p.retraction);
          fz = -state.z + state.swing * nat.swingScale * swingZ(s, p.settle);
          contact = false;
        }
      }

      const target = levelToBody([fx, fy, fz], state.roll, state.pitch, state.yawWag);
      n.q = Y.Motion.ik(L, target[0], target[1], target[2]);
      n.contact = contact;
      n.phase = ph;
    });
  }

  /* =====================================================================
     2. Figures
     ===================================================================== */

  // poses articulaires (haa, hfe, kfe), par patte avant / arrière
  const POSE = {
    tuck:  { front: [0, 1.55, -2.55], hind: [0, 1.35, -2.60] },   // groupé
    pike:  { front: [0, 1.70, -2.35], hind: [0, 1.15, -2.50] },   // groupé serré (double)
    reach: { front: [0, 0.55, -1.45], hind: [0, 0.85, -1.70] },   // jambes vers le sol
    twist: { front: [0.35, 1.45, -2.45], hind: [-0.35, 1.30, -2.50] }  // vrille : bras de levier
  };

  function poseFor(L, pose) {
    const base = (L.f > 0 ? pose.front : pose.hind).slice();
    base[0] *= L.m;                                     // l'abduction se reflète
    return base;
  }

  const FIGURES = {
    backflip: {
      label: "Salto arrière", turns: 1, twist: 0, cork: 0, air: "tuck",
      vz: 2.95, crouch: 0.34, load: 0.10, push: 0.19, land: 0.22, recover: 0.42,
      crouchZ: 0.165, takeoffZ: 0.32, absorbZ: 0.185, travel: -0.10
    },
    doubleflip: {
      label: "Double salto", turns: 2, twist: 0, cork: 0, air: "pike",
      vz: 4.20, crouch: 0.40, load: 0.12, push: 0.21, land: 0.26, recover: 0.50,
      crouchZ: 0.155, takeoffZ: 0.33, absorbZ: 0.175, travel: -0.16
    },
    mctwist540: {
      label: "540 McTwist", turns: 1, twist: 1.5, cork: 0.45, air: "twist",
      vz: 3.35, crouch: 0.36, load: 0.10, push: 0.20, land: 0.24, recover: 0.46,
      crouchZ: 0.160, takeoffZ: 0.32, absorbZ: 0.180, travel: -0.06
    }
  };

  Object.keys(FIGURES).forEach(function (k) {
    const f = FIGURES[k];
    f.id = k;
    f.flight = 2 * f.vz / G_ACC;
    f.apex = f.takeoffZ + f.vz * f.vz / (2 * G_ACC);
    f.duration = f.crouch + f.load + f.push + f.flight + f.land + f.recover;
  });

  const run = { fig: null, t: 0, takeoffQ: null, yaw0: 0 };

  function stepFigure(dt, state) {
    const f = run.fig;
    run.t += dt;
    const t = run.t;

    const tCrouch = f.crouch;
    const tLoad = tCrouch + f.load;
    const tPush = tLoad + f.push;
    const tFly = tPush + f.flight;
    const tLand = tFly + f.land;

    const groundPose = function (h, shiftX) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        n.q = Y.Motion.ik(L, L.x + (shiftX || 0), L.y + L.m * K.abadPlane, -h);
        n.contact = true;
      });
    };

    // interpolations de pose à vitesse bornée : on part de la pose mesurée au
    // décollage, sinon le passage appui -> groupé impose des dizaines de rad/s
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
    const poseToGround = function (pose, k, h, shiftX) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        const pa = poseFor(L, pose);
        const pb = Y.Motion.ik(L, L.x + shiftX, L.y + L.m * K.abadPlane, -h);
        n.q = [0, 1, 2].map(function (i) { return lerp(pa[i], pb[i], k); });
        n.contact = k > 0.5;
      });
    };

    let phase;
    if (t < tCrouch) {                                   // 1. accroupissement
      phase = "armement";
      const s = smooth(t / tCrouch);
      state.z = lerp(state.height, f.crouchZ, s);
      state.pitch = lerp(0, 0.06, s);
      groundPose(state.z, lerp(0, 0.02, s));
    } else if (t < tLoad) {                              // 2. bascule arrière
      phase = "bascule";
      const s = smooth((t - tCrouch) / f.load);
      state.z = f.crouchZ;
      state.pitch = lerp(0.06, -0.10, s);
      groundPose(state.z, lerp(0.02, -0.01, s));
    } else if (t < tPush) {                              // 3. poussée
      phase = "poussée";
      const s = smooth((t - tLoad) / f.push);
      state.z = lerp(f.crouchZ, f.takeoffZ, s);
      state.pitch = lerp(-0.10, -0.55, s);
      state.px += f.travel * dt * 0.5;
      groundPose(Math.min(state.z, K.L1 + K.L2 - 0.02), -0.01);
      run.takeoffQ = null;
    } else if (t < tFly) {                               // 4. vol balistique
      phase = f.twist ? "vrille" : "vol";
      const s = (t - tPush) / f.flight;
      const tf = t - tPush;
      state.z = f.takeoffZ + f.vz * tf - 0.5 * G_ACC * tf * tf;
      state.pitch = -0.55 - (2 * Math.PI * f.turns - 0.55) * smoother(s);
      if (f.twist) {
        state.yaw = run.yaw0 + 2 * Math.PI * f.twist * smoother(s);
        state.roll = Math.sin(Math.PI * s) * f.cork;
      }
      state.px += f.travel * dt / f.flight;
      if (!run.takeoffQ) {
        run.takeoffQ = Y.LEGS.reduce(function (acc, L) {
          return acc.concat(Y.Robot.legs[L.id].q);
        }, []);
      }
      if (s < 0.45) poseFrom(run.takeoffQ, POSE[f.air], smooth(s / 0.45));
      else poseMix(POSE[f.air], POSE.reach, smooth((s - 0.45) / 0.55));
    } else if (t < tLand) {                              // 5. réception amortie
      phase = "réception";
      const s = smooth((t - tFly) / f.land);
      // le tour est bouclé : -2π·n est la même orientation que 0
      state.z = lerp(f.takeoffZ, f.absorbZ, s);
      state.pitch = lerp(0, 0.12, s);
      state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
      poseToGround(POSE.reach, s, state.z, 0.015);
    } else {                                             // 6. stabilisation
      phase = "stabilisation";
      const s = smooth((t - tLand) / f.recover);
      const bounce = Math.sin(Math.PI * s * 2) * 0.012 * (1 - s);
      state.z = lerp(f.absorbZ, state.height, s) + bounce;
      state.pitch = lerp(0.12, 0, s) + Math.sin(Math.PI * s * 3) * 0.02 * (1 - s);
      state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
      groundPose(state.z, lerp(0.015, 0, s));
    }

    Y.Stunt.phase = phase;
    Y.Stunt.progress = clamp(t / f.duration, 0, 1);

    if (t >= f.duration) {
      state.pitch = 0;
      state.roll = 0;
      state.z = state.height;
      if (f.twist) state.yaw = run.yaw0 + 2 * Math.PI * f.twist;
      Y.Stunt.stop();
    }
  }

  Y.Stunt = {
    figures: FIGURES,
    active: null,
    phase: "",
    progress: 0,
    listeners: [],

    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () {
      const self = this;
      this.listeners.forEach(function (fn) { fn(self); });
    },

    label: function (name) { return FIGURES[name] ? FIGURES[name].label : ""; },
    duration: function (name) {
      const f = FIGURES[name || this.active];
      return f ? f.duration : 0;
    },
    info: function (name) {
      const f = FIGURES[name || this.active];
      if (!f) return null;
      return { label: f.label, flight: f.flight, apex: f.apex, duration: f.duration,
        turns: f.turns, twist: f.twist, vz: f.vz };
    },

    start: function (name) {
      const f = FIGURES[name];
      if (!f) return false;
      run.fig = f; run.t = 0; run.takeoffQ = null;
      run.yaw0 = Y.Motion.state.yaw;
      this.active = name;
      this.phase = "armement";
      this.progress = 0;
      this.emit();
      return true;
    },

    stop: function () {
      run.fig = null;
      this.active = null;
      this.phase = "";
      this.progress = 0;
      this.emit();
    },

    step: function (dt, state) {
      if (!run.fig) return false;
      stepFigure(dt, state);
      return true;
    }
  };

  Y.Natural = {
    profiles: PROFILES,
    state: nat,
    step: stepNatural,
    setProfile: function (name) {
      nat.profile = PROFILES[name] || PROFILES.souple;   // la posture est fondue
    },
    reset: function () {
      nat.vx = nat.vy = nat.wz = nat.ax = 0;
      const g = Y.GAITS[Y.Motion.state.gait] || Y.GAITS.trot;
      nat.duty = g.duty; nat.stance = g.stance;
      nat.trotMix = (g.name === "trot" || g.name === "bound") ? 1 : 0;
      nat.track = nat.profile.track; nat.heightBias = nat.profile.heightBias;
      nat.hindReach = nat.profile.hindReach; nat.swingScale = nat.profile.swingScale;
      Y.LEGS.forEach(function (L) {
        nat.lift[L.id] = null; nat.off[L.id] = g.off[L.id];
        nat.jit[L.id] = 0; nat.lastPh[L.id] = 0;
      });
    },
    setAuto: function (on) { nat.auto = !!on; },
    isAuto: function () { return nat.auto; }
  };
})(window.YLO);
