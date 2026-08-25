/* =====================================================================
   YLO-2 — styles de locomotion, terrain, roues et figures

   Le placement des pieds se fait en coordonnées MONDE : chaque appui est
   planté sur le sol au moment du poser, et l'on convertit ensuite dans le
   repère du tronc. C'est ce qui permet de suivre un escalier sans que les
   pieds glissent ni traversent les marches.

   Trois styles de marche (brut, souple, félin), une échelle d'allures qui
   monte du pas au galop selon la vitesse, un mode roues à la Go2-W, et
   trois figures avec vol balistique.
   ===================================================================== */
(function (Y) {
  "use strict";
  const K = Y.K;
  const G_ACC = 9.81;
  const WHEEL_R = 0.075;                 // rayon de roue (Go2-W : pneus 7")

  function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
  function smooth(s) { return s * s * (3 - 2 * s); }
  function smoother(s) { return s * s * s * (s * (s * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* =====================================================================
     1. Profils de locomotion
     ===================================================================== */
  const PROFILES = {
    souple: {
      accelLin: 1.20, accelAng: 2.4,
      raibert: 0.06, retraction: 1.18,
      dip: 0.011, sway: 0.014, swayLead: 0.00,
      bank: 0.55, pitchAccel: 0.16, pitchGait: 0.012, breath: 0.004, blend: 3.5,
      track: 1.00, dutyBias: 0.00, swingScale: 1.00, cycleScale: 1.00,
      yawWag: 0.000, jitter: 0.000, heightBias: 1.00, hindReach: 0.000,
      settle: 0.00, gaitScale: 1.00
    },
    felin: {
      // le chat marche bas, pose loin, garde trois appuis et se balance
      accelLin: 1.00, accelAng: 1.9,
      raibert: 0.05, retraction: 1.30,
      dip: 0.016, sway: 0.024, swayLead: 0.16,
      bank: 0.80, pitchAccel: 0.10, pitchGait: 0.004, breath: 0.005, blend: 1.8,
      track: 0.55, dutyBias: 0.05, swingScale: 0.80, cycleScale: 1.20,
      yawWag: 0.020, jitter: 0.014, heightBias: 0.93, hindReach: 0.022,
      settle: 0.14, gaitScale: 1.25          // marche plus longtemps avant de trotter
    }
  };

  const LADDER = ["walk", "trot", "canter", "gallop"];

  const nat = {
    profile: PROFILES.souple,
    vx: 0, vy: 0, wz: 0,
    ax: 0,
    plant: {}, lift: {}, land: {}, clear: {}, prevFoot: {}, wheelZ: {}, wstep: {}, figAxle: {},
    spin: {},                              // angle de roue
    jit: {}, lastPh: {},
    auto: true,
    duty: 0.5, stance: 0.25, trotMix: 1,
    off: {},
    track: 1, heightBias: 1, hindReach: 0, swingScale: 1,
    air: false, vz: 0, zBody: 0.25, zTarget: 0.25,
    airTime: 0, lastAir: 0,
    rough: 0, governor: 1, wheelWarn: 0,
    // sens de marche des roues : un 540 se reçoit en fakie, roues en arrière
    dir: 1
  };

  Y.LEGS.forEach(function (L) {
    nat.plant[L.id] = null; nat.lift[L.id] = null; nat.land[L.id] = null;
    nat.clear[L.id] = 0; nat.prevFoot[L.id] = null; nat.wheelZ[L.id] = null;
    nat.wstep[L.id] = null;
    nat.off[L.id] = 0; nat.jit[L.id] = 0; nat.lastPh[L.id] = 0; nat.spin[L.id] = 0;
  });

  function approach(current, target, rate, dt) {
    const step = rate * dt;
    if (Math.abs(target - current) <= step) return target;
    return current + Math.sign(target - current) * step;
  }

  function terrainAt(x, y) {
    return Y.Terrain ? Y.Terrain.heightAt(x, y) : 0;
  }

  /* --- échelle d'allures : la vitesse commande l'allure et la cadence --- */
  function autoGait(state) {
    if (!nat.auto) return;
    const p = nat.profile;
    const speed = Math.hypot(nat.vx, nat.vy) + Math.abs(nat.wz) * 0.12;
    if (speed < 0.02) { state.gait = "stand"; return; }
    // seuils : milieu géométrique entre les vitesses de référence, décalés
    // par le style (le félin marche plus longtemps avant de trotter)
    const bounds = [];
    for (let i = 0; i < LADDER.length - 1; i++) {
      bounds.push(Math.sqrt(Y.SPEED[LADDER[i]] * Y.SPEED[LADDER[i + 1]]) * p.gaitScale);
    }
    let want = LADDER[LADDER.length - 1];
    for (let i = 0; i < bounds.length; i++) {
      if (speed < bounds[i]) { want = LADDER[i]; break; }
    }
    // hystérésis : on ne change pas d'allure sur un frémissement
    const cur = LADDER.indexOf(state.gait);
    const idx = LADDER.indexOf(want);
    if (cur >= 0 && Math.abs(idx - cur) === 1) {
      const edge = bounds[Math.min(cur, idx)];
      if (idx > cur && speed < edge * 1.08) return;
      if (idx < cur && speed > edge * 0.92) return;
    }
    state.gait = want;
  }

  /**
   * Cadence : la durée d'appui décroît avec la vitesse (t ∝ v^-0.55, ce que
   * donnent les mesures sur animaux et sur quadrupèdes robotisés), l'amplitude
   * de pas augmente donc moins vite que la vitesse.
   */
  function cadence(g, speed) {
    const ref = Y.SPEED[g.name] || 0.5;
    if (!ref) return g.stance;
    const v = Math.max(speed, 0.04);
    return clamp(g.stance * Math.pow(ref / v, 0.55), g.stance * 0.55, g.stance * 2.2);
  }

  function blendGait(g, dt, speed) {
    const k = Math.min(1, dt * nat.profile.blend);
    nat.duty = lerp(nat.duty, g.duty, k);
    nat.stance = lerp(nat.stance, cadence(g, speed) * nat.profile.cycleScale, k);
    nat.trotMix = lerp(nat.trotMix, g.name === "walk" ? 0 : 1, k);
    Y.LEGS.forEach(function (L) {
      let d = g.off[L.id] - nat.off[L.id];
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      nat.off[L.id] = (nat.off[L.id] + d * k + 1) % 1;
    });
  }

  /* --- trajectoire de vol : Hermite raccordée à la vitesse d'appui --- */
  function swingXY(p0, p1, tangent, s, retraction) {
    const h00 = 2 * s * s * s - 3 * s * s + 1;
    const h10 = s * s * s - 2 * s * s + s;
    const h01 = -2 * s * s * s + 3 * s * s;
    const h11 = s * s * s - s * s;
    return h00 * p0 + h10 * tangent + h01 * p1 + h11 * tangent * retraction;
  }

  function swingZ(s, settle) {
    const e = Math.pow(clamp(s, 0, 1), 0.82);
    const base = Math.sin(Math.PI * e) * (1 - 0.18 * s);
    if (!settle) return base;
    const damp = s > 1 - settle ? smooth((1 - s) / settle) : 1;
    return base * damp;
  }

  /**
   * Ramène une cible dans l'enveloppe de travail de la patte : sans ça, une
   * marche trop haute ou une descente trop profonde sature la cinématique
   * inverse et fait claquer les angles.
   */
  function constrain(L, t) {
    const hx = L.x, hy = L.y, hz = K.legZ;
    let dx = t[0] - hx, dy = t[1] - hy, dz = t[2] - hz;
    // le pied reste sous sa hanche : au-dessus, la cinématique inverse
    // change de branche et les angles sautent d'un tour
    dz = Math.min(dz, -0.06);
    const off = Math.abs(K.abadPlane);
    const lat = Math.hypot(dy, dz);
    if (lat < off * 1.06) dz -= off * 1.06 - lat;
    const reach = Math.hypot(dx, dy, dz);
    const max = (K.L1 + K.L2) * 0.985, min = Math.abs(K.L1 - K.L2) + 0.045;
    if (reach > max) { const k = max / reach; dx *= k; dy *= k; dz *= k; }
    else if (reach < min && reach > 1e-6) { const k = min / reach; dx *= k; dy *= k; dz *= k; }
    return [hx + dx, hy + dy, hz + dz];
  }

  /** Angles continus : on garde la branche la plus proche du pas précédent. */
  function assign(n, q) {
    const prev = n.q;
    if (prev) {
      for (let i = 0; i < 3; i++) {
        while (q[i] - prev[i] > Math.PI) q[i] -= 2 * Math.PI;
        while (prev[i] - q[i] > Math.PI) q[i] += 2 * Math.PI;
      }
    }
    n.q = q;
  }

  /** Repère horizon -> repère tronc (appuis plantés malgré l'assiette). */
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

  /* =====================================================================
     2. Marche : appuis plantés en monde, terrain suivi
     ===================================================================== */
  function stepNatural(dt, state) {
    const p = nat.profile;
    const cmdVx = state.vx, cmdVy = state.vy, cmdWz = state.wz;
    const prevVx = nat.vx;

    // relief devant : on ralentit avant de l'aborder, comme un vrai robot
    const ahead = Y.Terrain ? Y.Terrain.stepAhead(state.px, state.py, state.yaw, 0.75) : 0;
    nat.rough = lerp(nat.rough, ahead, Math.min(1, dt * 3));
    nat.governor = clamp(1 - nat.rough / 0.22, 0.25, 1);

    nat.vx = approach(nat.vx, cmdVx * nat.governor, p.accelLin, dt);
    nat.vy = approach(nat.vy, cmdVy * nat.governor, p.accelLin, dt);
    nat.wz = approach(nat.wz, cmdWz, p.accelAng, dt);
    nat.ax = lerp(nat.ax, (nat.vx - prevVx) / Math.max(dt, 1e-3), Math.min(1, dt * 6));

    const kp = Math.min(1, dt * 2.5);
    nat.track = lerp(nat.track, p.track, kp);
    nat.heightBias = lerp(nat.heightBias, p.heightBias, kp);
    nat.hindReach = lerp(nat.hindReach, p.hindReach, kp);
    nat.swingScale = lerp(nat.swingScale, p.swingScale, kp);

    const speed = Math.hypot(nat.vx, nat.vy);
    autoGait(state);
    const g = Y.GAITS[state.gait];
    blendGait(g, dt, speed);

    const moving = state.gait !== "stand";
    // à vitesse élevée le rapport d'appui baisse : c'est ce qui ouvre les
    // phases de suspension, comme chez l'animal qui passe au galop
    const fastDuty = clamp(Math.hypot(nat.vx, nat.vy) / 1.4, 0, 1);
    const duty = moving ? clamp(nat.duty + p.dutyBias - 0.10 * fastDuty, 0.28, 0.80) : 1;
    const stance = nat.stance;
    const cycle = stance / Math.max(duty, 0.05);
    // sur relief, le robot se redresse : plus de garde sous le ventre
    const height = state.height * nat.heightBias * (1 + clamp(nat.rough / 0.20, 0, 1) * 0.18);

    if (moving) {
      state.phase = (state.phase + dt / cycle) % 1;
      state.yaw += nat.wz * dt;
      state.px += (nat.vx * Math.cos(state.yaw) - nat.vy * Math.sin(state.yaw)) * dt;
      state.py += (nat.vx * Math.sin(state.yaw) + nat.vy * Math.cos(state.yaw)) * dt;
    }

    // report de masse et balancement, atténués quand ça va vite
    const fast = clamp(speed / 1.2, 0, 1);
    const swayPhase = (state.phase + p.swayLead) * Math.PI * 2 + Math.PI / 2 * (1 - nat.trotMix);
    state.sway = moving ? Math.sin(swayPhase) * p.sway * lerp(1, 0.45, nat.trotMix) * (1 - 0.6 * fast) : 0;
    state.yawWag = moving ? -Math.sin(swayPhase) * p.yawWag * (1 - 0.5 * fast) : 0;

    // garde au sol : on lève plus haut quand on va vite
    const swingH = state.swing * nat.swingScale * (1 + 1.1 * fast) + nat.rough * 0.55;

    /* --- cinématique des pieds, en monde --- */
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const toWorld = function (x, y) {
      return [state.px + cy * x - sy * y, state.py + sy * x + cy * y];
    };

    let contacts = 0;
    const support = [];

    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      const nx = L.x + (L.f < 0 ? nat.hindReach : 0);
      const ny = (L.y + L.m * K.abadPlane) * nat.track - state.sway;
      const hip = toWorld(nx, ny);

      // vitesse du pied au sol dans le repère monde
      const vfx = nat.vx - nat.wz * ny;
      const vfy = nat.vy + nat.wz * nx;
      const sweep = stance;
      const wvx = cy * vfx - sy * vfy;
      const wvy = sy * vfx + cy * vfy;

      let ph = (state.phase + nat.off[L.id] + nat.jit[L.id]) % 1;
      if (ph < nat.lastPh[L.id]) nat.jit[L.id] = (Math.random() - 0.5) * p.jitter;
      nat.lastPh[L.id] = ph;

      let foot, contact;

      if (!moving) {
        const h = terrainAt(hip[0], hip[1]);
        foot = [hip[0], hip[1], h];
        nat.plant[L.id] = foot.slice();
        contact = true;
      } else if (ph < duty) {                       // --- appui ---
        if (!nat.plant[L.id]) {
          // on plante le pied là où le vol l'a réellement amené, pas sous la
          // hanche : sinon il saute d'une demi-course au moment du poser
          const src = nat.prevFoot[L.id] || nat.land[L.id] || [hip[0], hip[1], 0];
          nat.plant[L.id] = [src[0], src[1], terrainAt(src[0], src[1])];
        }
        foot = nat.plant[L.id];
        nat.lift[L.id] = foot.slice();
        contact = true;
      } else {                                      // --- vol ---
        const s = (ph - duty) / (1 - duty);
        if (nat.plant[L.id]) { nat.lift[L.id] = nat.plant[L.id].slice(); nat.plant[L.id] = null; }
        const p0 = nat.lift[L.id] || [hip[0], hip[1], 0];

        // pose visée : demi-course devant la hanche + rattrapage de vitesse
        const errX = (nat.vx - cmdVx) * p.raibert, errY = (nat.vy - cmdVy) * p.raibert;
        const tdx = hip[0] + wvx * sweep * 0.5 + (cy * errX - sy * errY);
        const tdy = hip[1] + wvy * sweep * 0.5 + (sy * errX + cy * errY);
        // la cible de poser et le dégagement sont lissés : le relief change
        // par marches, et un saut de cible se paierait en dizaines de rad/s
        let wanted = [tdx, tdy, terrainAt(tdx, tdy)];
        // pas raccourci si la cible sort du domaine atteignable depuis la hanche
        const hz = nat.zBody + K.legZ;
        const drop = hz - wanted[2];
        const maxHoriz = Math.sqrt(Math.max(0.01,
          Math.pow((K.L1 + K.L2) * 0.93, 2) - drop * drop));
        const dxh = wanted[0] - hip[0], dyh = wanted[1] - hip[1];
        const horiz = Math.hypot(dxh, dyh);
        if (horiz > maxHoriz) {
          const kk = maxHoriz / horiz;
          wanted = [hip[0] + dxh * kk, hip[1] + dyh * kk, terrainAt(hip[0] + dxh * kk, hip[1] + dyh * kk)];
        }
        const obstacle = Y.Terrain ? Y.Terrain.maxHeightAlong(p0[0], p0[1], tdx, tdy, 8) : 0;
        if (!nat.land[L.id]) { nat.land[L.id] = wanted; nat.clear[L.id] = obstacle; }
        else {
          const kl = Math.min(1, dt * 9);
          for (let i = 0; i < 3; i++) {
            nat.land[L.id][i] = lerp(nat.land[L.id][i], wanted[i], kl);
          }
          nat.clear[L.id] = lerp(nat.clear[L.id], obstacle, kl);
        }
        const land = nat.land[L.id];

        const tanX = wvx * sweep * (1 - duty) / duty;
        const tanY = wvy * sweep * (1 - duty) / duty;
        const fx = swingXY(p0[0], land[0], tanX, s, p.retraction);
        const fy = swingXY(p0[1], land[1], tanY, s, p.retraction);

        const line = lerp(p0[2], land[2], smooth(s));
        const over = Math.max(0, Math.max(p0[2], land[2], nat.clear[L.id]) - line);
        const fz = line + over * Math.sin(Math.PI * clamp(s, 0, 1)) * 1.0 +
          swingH * swingZ(s, p.settle);
        foot = [fx, fy, fz];
        contact = false;
      }

      // limiteur : un pied ne se déplace pas plus vite que ce que les
      // actionneurs permettent (≈ 4 m/s au bout d'une patte de 0,22 m)
      const prevF = nat.prevFoot[L.id];
      if (prevF) {
        const dxf = foot[0] - prevF[0], dyf = foot[1] - prevF[1], dzf = foot[2] - prevF[2];
        const dist = Math.hypot(dxf, dyf, dzf);
        const maxd = 4.0 * dt;
        if (dist > maxd) {
          const kf = maxd / dist;
          foot = [prevF[0] + dxf * kf, prevF[1] + dyf * kf, prevF[2] + dzf * kf];
        }
      }
      nat.prevFoot[L.id] = foot;

      n.footWorld = foot;
      n.contact = contact;
      n.phase = ph;
      if (contact) { contacts++; support.push({ L: L, f: foot }); }
    });

    /* --- caisse : appui sur les pieds au sol, sinon vol balistique --- */
    let groundZ = 0, highest = -9, front = 0, rear = 0, nf = 0, nr = 0, left = 0, right = 0, nl = 0, nrt = 0;
    support.forEach(function (s) {
      groundZ += s.f[2];
      highest = Math.max(highest, s.f[2]);
      if (s.L.f > 0) { front += s.f[2]; nf++; } else { rear += s.f[2]; nr++; }
      if (s.L.m > 0) { left += s.f[2]; nl++; } else { right += s.f[2]; nrt++; }
    });
    // moyenne des appuis, tirée vers le plus haut : sur une marche, la caisse
    // doit monter avant que les pattes arrière n'aient suivi
    groundZ = contacts ? lerp(groundZ / contacts, highest, 0.55) : nat.zBody - height;

    const dip = moving ? p.dip * (1 + 2.4 * fast) : 0;
    nat.zTarget = groundZ + height - dip * 0.5 +
      (moving ? 0 : Math.sin(state.t * 1.6) * p.breath);

    if (contacts === 0) {                            // suspension
      nat.air = true;
      nat.airTime += dt;
      nat.vz -= G_ACC * dt;
      nat.zBody += nat.vz * dt;
      if (nat.zBody < nat.zTarget) { nat.zBody = nat.zTarget; nat.vz = 0; }
    } else {
      if (nat.air) {                                  // réception : on encaisse
        nat.lastAir = nat.airTime;
        nat.airTime = 0;
        nat.vz = Math.min(nat.vz, -0.15);
      }
      nat.air = false;
      // rappel amorti vers la hauteur visée (compliance de patte)
      const k = 90, c = 2 * Math.sqrt(k) * 0.85;
      const acc = k * (nat.zTarget - nat.zBody) - c * nat.vz;
      nat.vz = clamp(nat.vz + acc * dt, -1.0, 1.0);     // la caisse ne saute pas
      nat.zBody += nat.vz * dt;
      if (moving && speed > 0.6) {
        // à l'appui, la poussée relance la caisse vers le haut en fin de phase
        nat.vz += 0.9 * fast * dt * (contacts >= 2 ? 1 : 0.4) * G_ACC * 0.12;
      }
    }
    state.z = nat.zBody;

    // assiette : on épouse la pente du support
    const slopePitch = (nf && nr) ? Math.atan2(rear / nr - front / nf, 2 * K.legX) : 0;
    const slopeRoll = (nl && nrt) ? Math.atan2(left / nl - right / nrt, 2 * K.legY) : 0;
    const bankIdeal = Math.atan2(nat.vx * nat.wz, G_ACC);
    const pitchGait = moving ? Math.sin(state.phase * Math.PI * 4 + 1.1) * p.pitchGait * (1 + 2.2 * fast) : 0;
    state.roll = lerp(state.roll, slopeRoll - bankIdeal * p.bank + state.sway * 0.9, Math.min(1, dt * 6));
    state.pitch = lerp(state.pitch,
      slopePitch + clamp(nat.ax, -2, 2) * p.pitchAccel + pitchGait, Math.min(1, dt * 6));

    /* --- cinématique inverse, cible ramenée dans le repère tronc --- */
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      const f = n.footWorld;
      const dx = f[0] - state.px, dy = f[1] - state.py;
      const level = [cy * dx + sy * dy, -sy * dx + cy * dy, f[2] - state.z];
      const target = constrain(L, levelToBody(level, state.roll, state.pitch, state.yawWag));
      assign(n, Y.Motion.ik(L, target[0], target[1], target[2]));
    });
  }

  /* =====================================================================
     3. Mode roues — inspiré des Go2-W / B2-W
     ===================================================================== */
  function stepWheels(dt, state) {
    const prevVx = nat.vx;

    // relief devant : on lève le pied du champignon avant de l'aborder
    const ahead = Y.Terrain ? Y.Terrain.stepAhead(state.px, state.py, state.yaw, 0.9) : 0;
    nat.rough = lerp(nat.rough, ahead, Math.min(1, dt * 3));
    nat.governor = clamp(1 - nat.rough / 0.30, 0.28, 1);

    const cmdVx = clamp(state.vx * nat.dir, -Y.SPEED.wheelMax, Y.SPEED.wheelMax) * nat.governor;
    // freinage plus vif que l'accélération : les roues mordent
    const braking = Math.abs(cmdVx) < Math.abs(nat.vx) * 0.98;
    nat.vx = approach(nat.vx, cmdVx, braking ? 4.5 : 2.4, dt);
    if (Math.abs(cmdVx) < 1e-3 && Math.abs(nat.vx) < 0.02) nat.vx = 0;   // arrêt franc
    nat.vy = approach(nat.vy, 0, 2.4, dt);           // pas de dérive latérale
    nat.wz = approach(nat.wz, state.wz, 3.2, dt);
    nat.ax = lerp(nat.ax, (nat.vx - prevVx) / Math.max(dt, 1e-3), Math.min(1, dt * 8));

    state.gait = "roues";
    state.phase = (state.phase + dt * 0.6) % 1;
    state.yaw += nat.wz * dt;
    state.px += nat.vx * Math.cos(state.yaw) * dt;
    state.py += nat.vx * Math.sin(state.yaw) * dt;

    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    // sur relief, la caisse se redresse pour laisser du débattement
    const height = state.height * 0.92 * (1 + clamp(nat.rough / 0.25, 0, 1) * 0.22);
    let groundZ = 0, grounded = 0, front = 0, rear = 0, left = 0, right = 0;

    const contacts = [];
    const speedNow = Math.abs(nat.vx);
    let stepping = 0;
    Y.LEGS.forEach(function (L) { if (nat.wstep[L.id]) stepping++; });

    Y.LEGS.forEach(function (L) {
      const nx = L.x, ny = L.y + L.m * K.abadPlane;
      const wx = state.px + cy * nx - sy * ny;
      const wy = state.py + sy * nx + cy * ny;
      const raw = terrainAt(wx, wy);

      // marche sous la roue : une roue de 75 mm ne monte pas une marche de
      // 130 mm, la patte la soulève par-dessus — c'est ce que fait un Go2-W
      const look = 0.22 * (nat.vx >= 0 ? 1 : -1);
      const aheadH = terrainAt(wx + cy * look, wy + sy * look);
      const rise = aheadH - raw;
      const partner = { lf: "rh", rh: "lf", rf: "lh", lh: "rf" }[L.id];
      if (!nat.wstep[L.id] && Math.abs(rise) > WHEEL_R * 0.45 &&
          stepping < 2 && !nat.wstep[partner] && speedNow < 1.5) {
        const cur = nat.wheelZ[L.id];
        nat.wstep[L.id] = { t: 0, dur: 0.34,
          from: (cur === null || cur === undefined) ? raw : cur, to: aheadH };
        stepping++;
      }

      let h, contact = true;
      const st = nat.wstep[L.id];
      if (st) {
        st.t += dt;
        const s = clamp(st.t / st.dur, 0, 1);
        const top = Math.max(st.from, st.to);
        // la roue suit la ligne de la marche, plus un arc de dégagement :
        // sans le sinus, tout le dénivelé s'appliquerait dès le premier pas
        const line = lerp(st.from, st.to, smooth(s));
        h = line + (0.055 + Math.max(0, top - Math.max(st.from, st.to))) * Math.sin(Math.PI * s);
        contact = s > 0.85;
        if (s >= 1) { nat.wheelZ[L.id] = st.to; nat.wstep[L.id] = null; }
      } else {
        // suspension : hauteur filtrée et vitesse de débattement bornée
        const prevH = nat.wheelZ[L.id];
        if (prevH === null || prevH === undefined) h = raw;
        else {
          const target = lerp(prevH, raw, Math.min(1, dt * 8));
          const maxRate = 0.55 * dt;
          h = clamp(target, prevH - maxRate, prevH + maxRate);
        }
      }
      nat.wheelZ[L.id] = h;
      contacts.push({ L: L, x: wx, y: wy, z: h, contact: contact });
      if (contact) { groundZ += h; grounded++; }
      if (L.f > 0) front += h / 2; else rear += h / 2;
      if (L.m > 0) left += h / 2; else right += h / 2;

      // rotation de roue : ω = v / R (plus le différentiel de virage)
      const vWheel = nat.vx - nat.wz * ny;
      nat.spin[L.id] = (nat.spin[L.id] + vWheel / WHEEL_R * dt) % (Math.PI * 2);
    });

    // suspension : la caisse suit le sol filtré des roues au contact
    groundZ = grounded ? groundZ / grounded : nat.zBody - height - WHEEL_R;
    nat.zTarget = groundZ + height + WHEEL_R;
    const k = 60, c = 2 * Math.sqrt(k) * 0.9;
    nat.vz += (k * (nat.zTarget - nat.zBody) - c * nat.vz) * dt;
    nat.zBody += nat.vz * dt;
    state.z = nat.zBody;

    const slopePitch = Math.atan2(rear - front, 2 * K.legX);
    const slopeRoll = Math.atan2(left - right, 2 * K.legY);
    const bankIdeal = Math.atan2(nat.vx * nat.wz, G_ACC);
    // plongée au freinage, cabrage à l'accélération : c'est ce qui donne le poids
    state.pitch = lerp(state.pitch, slopePitch + clamp(nat.ax, -4, 4) * 0.10, Math.min(1, dt * 8));
    state.roll = lerp(state.roll, slopeRoll - bankIdeal * 0.9, Math.min(1, dt * 8));
    state.sway = 0; state.yawWag = 0;

    // obstacle trop haut : une roue ne monte pas une marche plus haute qu'elle
    const step = Y.Terrain ? Y.Terrain.stepAhead(state.px, state.py, state.yaw, 0.7) : 0;
    nat.wheelWarn = step > WHEEL_R * 0.9 ? step : 0;

    Y.LEGS.forEach(function (L, i) {
      const n = Y.Robot.legs[L.id];
      const c = contacts[i];
      const dx = c.x - state.px, dy = c.y - state.py;
      const level = [cy * dx + sy * dy, -sy * dx + cy * dy, c.z + WHEEL_R - state.z];
      const target = constrain(L, levelToBody(level, state.roll, state.pitch, 0));
      assign(n, Y.Motion.ik(L, target[0], target[1], target[2]));
      n.contact = c.contact !== false;
      n.phase = 0;
      n.footWorld = [c.x, c.y, c.z];
      if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
    });
  }

  /* =====================================================================
     4. Figures
     ===================================================================== */
  const POSE = {
    tuck:  { front: [0, 1.55, -2.55], hind: [0, 1.35, -2.60] },
    pike:  { front: [0, 1.70, -2.35], hind: [0, 1.15, -2.50] },
    reach: { front: [0, 0.55, -1.45], hind: [0, 0.85, -1.70] },
    twist: { front: [0.35, 1.45, -2.45], hind: [-0.35, 1.30, -2.50] }
  };

  function poseFor(L, pose) {
    const base = (L.f > 0 ? pose.front : pose.hind).slice();
    base[0] *= L.m;
    return base;
  }

  /** Pose interpolée depuis une pose mesurée (vitesse bornée, sans à-coup). */
  function poseFromQ(start, pose, k) {
    Y.LEGS.forEach(function (L, li) {
      const n = Y.Robot.legs[L.id];
      const target = poseFor(L, pose);
      n.q = [0, 1, 2].map(function (i) { return lerp(start[li * 3 + i], target[i], k); });
      n.contact = false;
    });
  }

  function poseMixQ(a, b, k) {
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      const pa = poseFor(L, a), pb = poseFor(L, b);
      n.q = [0, 1, 2].map(function (i) { return lerp(pa[i], pb[i], k); });
      n.contact = false;
    });
  }

  function captureQ() {
    return Y.LEGS.reduce(function (acc, L) {
      return acc.concat(Y.Robot.legs[L.id].q);
    }, []);
  }

  const FIGURES = {
    backflip: {
      label: "Salto arrière", mode: "pattes", turns: 1, twist: 0, cork: 0, air: "tuck",
      vz: 2.95, crouch: 0.34, load: 0.10, push: 0.19, land: 0.22, recover: 0.42,
      crouchZ: 0.165, takeoffZ: 0.32, absorbZ: 0.185, travel: -0.10
    },
    doubleflip: {
      label: "Double salto", mode: "pattes", turns: 2, twist: 0, cork: 0, air: "pike",
      vz: 4.20, crouch: 0.40, load: 0.12, push: 0.21, land: 0.26, recover: 0.50,
      crouchZ: 0.155, takeoffZ: 0.33, absorbZ: 0.175, travel: -0.16
    },
    // Salto avant : `sense` = -1 retourne le chargement, la poussée et la
    // rotation. Il faut un peu plus d'impulsion qu'en arrière : la caisse
    // pique du nez, elle a moins de course pour ouvrir avant le poser.
    frontflip: {
      label: "Salto avant", mode: "pattes", turns: 1, sense: -1, twist: 0, cork: 0, air: "tuck",
      vz: 3.10, crouch: 0.34, load: 0.10, push: 0.19, land: 0.24, recover: 0.44,
      crouchZ: 0.165, takeoffZ: 0.32, absorbZ: 0.185, travel: 0.10
    },
    mctwist540: {
      label: "540 McTwist", mode: "pattes", turns: 1, twist: 1.5, cork: 0.45, air: "twist",
      vz: 3.35, crouch: 0.36, load: 0.10, push: 0.20, land: 0.24, recover: 0.46,
      crouchZ: 0.160, takeoffZ: 0.32, absorbZ: 0.180, travel: -0.06
    }
  };

  /* --- figures sur roues, dans l'esprit des démonstrations Go2-W --- */
  const WHEEL_FIGURES = {
    // Tenues sur deux roues. La caisse bascule autour de l'essieu resté au
    // sol pendant que les pattes porteuses se replient pour la mettre à
    // l'aplomb de cet appui. En pilotant les hauteurs d'essieu une par une,
    // comme le faisait la première version, il aurait fallu allonger les
    // jambes de toute la hauteur gagnée : ça plafonnait vers 30°.
    wheelie: {
      label: "Cabrage", mode: "roues", kind: "tilt", axis: "pitch",
      arm: 0.30, rise: 0.60, hold: 1.40, drop: 0.65,
      angle: -1.45, stand: 0.34, wobble: 0.030, sustain: true
    },
    sidestand: {
      label: "Sur deux roues", mode: "roues", kind: "tilt", axis: "roll",
      arm: 0.30, rise: 0.70, hold: 1.60, drop: 0.75,
      angle: 1.40, stand: 0.30, wobble: 0.035, sustain: true
    },
    pirouette: {
      label: "Pirouette", mode: "roues", kind: "spin",
      arm: 0.22, spin: 1.20, settle: 0.35,
      turns: 1.5, lean: 0.20
    },
    wheeljump: {
      label: "Saut", mode: "roues", kind: "jump",
      crouch: 0.30, push: 0.16, land: 0.26, recover: 0.34,
      vz: 2.30, crouchZ: 0.80, tuck: 0.15
    },
    wheelflip: {
      label: "Salto roues", mode: "roues", kind: "flip",
      crouch: 0.34, push: 0.20, land: 0.26, recover: 0.42,
      vz: 2.95, crouchZ: 0.72, turns: 1, tuck: 0.20
    },
    // Sur roues, la détente vient des seules jambes : pour deux tours il faut
    // la même impulsion que sur pattes (4,2 m/s), donc un accroupissement plus
    // franc et une phase de reprise allongée.
    wheeldoubleflip: {
      label: "Double salto roues", mode: "roues", kind: "flip",
      crouch: 0.40, push: 0.22, land: 0.28, recover: 0.50,
      vz: 4.20, crouchZ: 0.66, turns: 2, tuck: 0.16
    },
    // Salto avant : même mécanique, sens inverse. `sense` vaut +1 pour une
    // rotation arrière et -1 pour une rotation avant ; il retourne le
    // chargement, la poussée et la rotation d'un seul coup.
    wheelfrontflip: {
      label: "Salto avant roues", mode: "roues", kind: "flip",
      crouch: 0.34, push: 0.20, land: 0.28, recover: 0.44,
      vz: 3.05, crouchZ: 0.70, turns: 1, sense: -1, tuck: 0.18
    },
    // Saltos latéraux : un tour complet autour de l'axe de roulis, d'un côté
    // ou de l'autre. Les jambes sont figées dans le repère de la caisse
    // pendant la rotation, exactement comme pour un salto de tangage.
    wheelsideflipL: {
      label: "Salto latéral gauche", mode: "roues", kind: "flip",
      crouch: 0.34, push: 0.20, land: 0.28, recover: 0.44,
      vz: 3.05, crouchZ: 0.70, rollTurns: 1, tuck: 0.18
    },
    wheelsideflipR: {
      label: "Salto latéral droit", mode: "roues", kind: "flip",
      crouch: 0.34, push: 0.20, land: 0.28, recover: 0.44,
      vz: 3.05, crouchZ: 0.70, rollTurns: -1, tuck: 0.18
    },
    // Powerslide : la caisse pivote en travers pendant que la quantité de
    // mouvement continue tout droit. Les pneus chassent, le robot s'incline
    // dans le dérapage et s'arrête net — la figure qui clôt une session.
    powerslide: {
      label: "Slide", mode: "roues", kind: "slide",
      entry: 0.20, slide: 0.95, settle: 0.45,
      yawSweep: 1.35, lean: 0.26, decel: 3.4
    },
    // McTwist : un salto arrière complet pendant que la caisse vrille d'un
    // tour et demi, avec un peu de gîte (« cork ») pour que l'axe de vrille
    // soit incliné, comme sur la figure de skate d'origine.
    wheeltwist540: {
      label: "540 McTwist roues", mode: "roues", kind: "flip",
      crouch: 0.36, push: 0.20, land: 0.26, recover: 0.46,
      vz: 3.35, crouchZ: 0.70, turns: 1, twist: 1.5, cork: 0.45, tuck: 0.18
    }
  };

  Object.keys(WHEEL_FIGURES).forEach(function (k) {
    const f = WHEEL_FIGURES[k];
    f.id = k;
    if (f.vz) {
      f.flight = 2 * f.vz / G_ACC;
      f.apex = f.vz * f.vz / (2 * G_ACC);
      f.duration = f.crouch + f.push + f.flight + f.land + f.recover;
    } else if (f.kind === "tilt") {
      f.duration = f.arm + f.rise + f.hold + f.drop;
      f.flight = 0; f.apex = 0;
    } else if (f.kind === "slide") {
      f.duration = f.entry + f.slide + f.settle;
      f.flight = 0; f.apex = 0;
    } else {
      f.duration = f.arm + f.spin + f.settle;
      f.flight = 0; f.apex = 0;
    }
    FIGURES[k] = f;
  });

  Object.keys(FIGURES).forEach(function (k) {
    const f = FIGURES[k];
    if (f.mode === "roues") return;
    f.id = k;
    f.mode = f.mode || "pattes";
    f.flight = 2 * f.vz / G_ACC;
    f.apex = f.takeoffZ + f.vz * f.vz / (2 * G_ACC);
    f.duration = f.crouch + f.load + f.push + f.flight + f.land + f.recover;
  });

  const run = { fig: null, t: 0, takeoffQ: null, yaw0: 0, ground: 0,
                holdQ: null, holdZ: 0, shiftX: 0, shiftY: 0,
                carry: null, fakie: false, holdT: 0, release: false, prevA: {},
                entryQ: null, landZ0: null, takeoffZ: null,
                groundRef: null, entryZ: null };

  function stepFigure(dt, state) {
    const f = run.fig;
    run.t += dt;
    const t = run.t;
    const base = run.ground;

    const tCrouch = f.crouch;
    const tLoad = tCrouch + f.load;
    const tPush = tLoad + f.push;
    const tFly = tPush + f.flight;
    const tLand = tFly + f.land;

    const groundPose = function (h, shiftX) {
      // Entrée de figure : on vient de la pose de marche, qui n'a aucune
      // raison d'être celle de l'armement. Sans ce fondu la première image
      // saute — le robot ne bouge pas vraiment, mais le moteur, si.
      const k = run.entryQ ? smooth(Math.min(1, run.t / Math.max(f.crouch * 0.5, 1e-3))) : 1;
      Y.LEGS.forEach(function (L, li) {
        const n = Y.Robot.legs[L.id];
        const q = Y.Motion.ik(L, L.x + (shiftX || 0), L.y + L.m * K.abadPlane, -(h - base));
        n.q = k >= 1 ? q
          : [0, 1, 2].map(function (i) { return lerp(run.entryQ[li * 3 + i], q[i], k); });
        n.contact = true;
      });
    };
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
        const pb = Y.Motion.ik(L, L.x + shiftX, L.y + L.m * K.abadPlane, -(h - base));
        n.q = [0, 1, 2].map(function (i) { return lerp(pa[i], pb[i], k); });
        n.contact = k > 0.5;
      });
    };

    // `sense` vaut +1 pour un salto arrière, -1 pour un salto avant : il
    // retourne la bascule d'armement, la poussée et le sens de rotation.
    const sense = f.sense || 1;
    let phase;
    if (t < tCrouch) {
      phase = "armement";
      const s = smooth(t / tCrouch);
      state.z = lerp(state.height + base, f.crouchZ + base, s);
      state.pitch = lerp(0, 0.06 * sense, s);
      groundPose(state.z, lerp(0, 0.02 * sense, s));
    } else if (t < tLoad) {
      phase = "bascule";
      const s = smooth((t - tCrouch) / f.load);
      state.z = f.crouchZ + base;
      state.pitch = lerp(0.06 * sense, -0.10 * sense, s);
      groundPose(state.z, lerp(0.02 * sense, -0.01 * sense, s));
    } else if (t < tPush) {
      phase = "poussée";
      const s = smooth((t - tLoad) / f.push);
      state.z = lerp(f.crouchZ, f.takeoffZ, s) + base;
      state.pitch = lerp(-0.10 * sense, -0.55 * sense, s);
      state.px += f.travel * dt * 0.5;
      groundPose(Math.min(state.z, base + K.L1 + K.L2 - 0.02), -0.01 * sense);
      run.takeoffQ = null;
    } else if (t < tFly) {
      phase = f.twist ? "vrille" : "vol";
      const s = (t - tPush) / f.flight;
      const tf = t - tPush;
      state.z = base + f.takeoffZ + f.vz * tf - 0.5 * G_ACC * tf * tf;
      state.pitch = -0.55 * sense - (2 * Math.PI * f.turns * sense - 0.55 * sense) * smoother(s);
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
    } else if (t < tLand) {
      phase = "réception";
      const s = smooth((t - tFly) / f.land);
      state.z = base + lerp(f.takeoffZ, f.absorbZ, s);
      state.pitch = lerp(0, 0.12, s);
      state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
      poseToGround(POSE.reach, s, state.z, 0.015);
    } else {
      phase = "stabilisation";
      const s = smooth((t - tLand) / f.recover);
      const bounce = Math.sin(Math.PI * s * 2) * 0.012 * (1 - s);
      state.z = base + lerp(f.absorbZ, state.height, s) + bounce;
      state.pitch = lerp(0.12, 0, s) + Math.sin(Math.PI * s * 3) * 0.02 * (1 - s);
      state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
      groundPose(state.z, lerp(0.015, 0, s));
    }

    Y.Stunt.phase = phase;
    Y.Stunt.progress = clamp(t / f.duration, 0, 1);

    if (t >= f.duration) {
      state.pitch = 0; state.roll = 0;
      state.z = base + state.height;
      if (f.twist) state.yaw = run.yaw0 + 2 * Math.PI * f.twist;
      nat.zBody = state.z; nat.vz = 0;
      // Le générateur d'allure raisonne en appuis plantés dans le monde. Après
      // une figure — surtout un 540, qui tourne le robot d'un demi-tour et le
      // déplace — ces repères datent d'avant et ne sont plus sous les hanches :
      // le premier pas visait alors des cibles aberrantes, la butée d'abduction
      // s'en mêlait et les pattes s'entremêlaient. On repart d'une ardoise
      // vierge, et on fond la pose pour que la reprise ne saute pas.
      Y.LEGS.forEach(function (L) {
        nat.plant[L.id] = null; nat.lift[L.id] = null; nat.land[L.id] = null;
        nat.prevFoot[L.id] = null; nat.clear[L.id] = 0;
      });
      Y.Motion.blendFrom(0.28);
      Y.Stunt.stop(true);
    }
  }

  /**
   * Figures sur roues : la caisse est pilotée en hauteur et en assiette, et
   * chaque roue reçoit une hauteur d'axe — au sol (terrain + rayon) ou en
   * l'air. Les jambes ne font que tenir la roue là où on la veut.
   */
  function stepWheelFigure(dt, state) {
    const f = run.fig;
    run.t += dt;
    const t = run.t;
    const base = run.ground;
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const ride = state.height * 0.92;

    // Avance libre : une figure sur roues garde sa vitesse. Pendant une
    // vrille, c'est la quantité de mouvement qui porte le robot en ligne
    // droite — pas son cap, qui tourne sous lui. Sans ça le 540 décrivait
    // une spirale puis repartait dans l'autre sens au poser.
    if (run.carry) {
      state.px += run.carry[0] * dt;
      state.py += run.carry[1] * dt;
    } else {
      state.px += nat.vx * cy * dt;
      state.py += nat.vx * sy * dt;
    }
    Y.LEGS.forEach(function (L) {
      const ny = L.y + L.m * K.abadPlane;
      nat.spin[L.id] = (nat.spin[L.id] + (nat.vx - nat.wz * ny) / WHEEL_R * dt) % (Math.PI * 2);
    });

    /** Place les roues : `axle(L)` rend la hauteur d'axe voulue, en monde. */
    const place = function (axle, contactOf) {
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        const nx = L.x, ny = L.y + L.m * K.abadPlane;
        const wx = state.px + cy * nx - sy * ny;
        const wy = state.py + sy * nx + cy * ny;
        // on borne le débattement RELATIF à la caisse : pendant un vol
        // balistique, la caisse monte à 3 m/s et les jambes doivent suivre,
        // ce sont les mouvements par rapport au tronc qui coûtent des rad/s
        let rel = axle(L, terrainAt(wx, wy)) - state.z;
        const prevRel = nat.figAxle[L.id];
        if (prevRel !== null && prevRel !== undefined) {
          rel = clamp(rel, prevRel - 1.6 * dt, prevRel + 1.6 * dt);
        }
        nat.figAxle[L.id] = rel;
        const z = state.z + rel;
        const dx = wx - state.px, dy = wy - state.py;
        const level = [cy * dx + sy * dy, -sy * dx + cy * dy, z - state.z];
        const target = constrain(L, levelToBody(level, state.roll, state.pitch, 0));
        assign(n, Y.Motion.ik(L, target[0], target[1], target[2]));
        n.contact = contactOf ? contactOf(L) : true;
        n.footWorld = [wx, wy, z - WHEEL_R];
        if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
      });
    };

    let phase = "";

    if (f.kind === "tilt") {
      const t1 = f.arm, t2 = t1 + f.rise, t3 = t2 + f.hold;
      // essieux qui restent au sol : l'arrière pour le cabrage, le côté
      // droit pour la tenue latérale
      const onGround = f.axis === "roll"
        ? function (L) { return L.m < 0; }
        : function (L) { return L.f < 0; };

      /**
       * Position de l'essieu d'une patte dans le repère caisse.
       *
       * Les pattes levées gardent la pose figée à l'armement : leur essieu
       * ne bouge pas d'un iota dans ce repère. Les pattes porteuses, elles,
       * se replient pour amener la caisse **à l'aplomb** de leur essieu —
       * sinon le tronc bascule derrière l'appui et le robot tomberait en
       * arrière. C'est ce que fait le robot réel : il ne se contente pas de
       * pivoter, il se ramasse au-dessus de ses roues.
       */
      const axleOf = function (L, k) {
        const ny = L.y + L.m * K.abadPlane;
        if (!onGround(L)) return [L.x, ny, run.holdZ];
        // cible : essieu droit sous l'origine caisse une fois basculé
        const a1 = f.axis === "roll"
          ? [L.x, -Math.sin(f.angle) * f.stand, -Math.cos(f.angle) * f.stand]
          : [Math.sin(f.angle) * f.stand, ny, -Math.cos(f.angle) * f.stand];
        return [lerp(L.x, a1[0], k), lerp(ny, a1[1], k), lerp(run.holdZ, a1[2], k)];
      };

      /**
       * Basculement autour de l'essieu d'appui, qui reste posé au millimètre.
       * `k` mène le repliement, `angle` l'inclinaison de la caisse.
       */
      const tilt = function (k, angle) {
        const roll = f.axis === "roll" ? angle : 0;
        const pitch = f.axis === "roll" ? 0 : angle;
        state.roll = roll; state.pitch = pitch;
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        // un point de la caisse, vu dans le repère horizontal
        const rot = function (a) {
          const yr = cr * a[1] - sr * a[2];
          const zr = sr * a[1] + cr * a[2];
          return [cp * a[0] + sp * zr, yr, -sp * a[0] + cp * zr];
        };
        // Cibles d'essieu de l'image, bornées en vitesse. Sur sol plat la
        // bascule est bien plus lente que la borne et rien ne change ; sur un
        // relief — le quarter pipe du skatepark — c'est ce qui évite qu'entrer
        // en tenue coûte 41 rad/s d'un coup.
        const axles = {};
        Y.LEGS.forEach(function (L) {
          const want = axleOf(L, k);
          const prev = run.prevA[L.id];
          if (prev) {
            for (let i = 0; i < 3; i++) {
              want[i] = clamp(want[i], prev[i] - 1.6 * dt, prev[i] + 1.6 * dt);
            }
          }
          run.prevA[L.id] = want;
          axles[L.id] = want;
        });
        // la caisse se replace pour que l'essieu porteur reste au sol
        let ax = 0, ay = 0, az2 = 0, fx = 0, fy = 0, n0 = 0;
        Y.LEGS.forEach(function (L) {
          if (!onGround(L)) return;
          const o = rot(axles[L.id]);
          ax += o[0]; ay += o[1]; az2 += o[2];
          fx += L.x; fy += L.y + L.m * K.abadPlane; n0++;
        });
        ax /= n0; ay /= n0; az2 /= n0; fx /= n0; fy /= n0;
        state.z = base + WHEEL_R - az2;
        // glissement par rapport à la trajectoire « à plat » : en se dressant,
        // le robot se replace réellement au-dessus de son appui
        const sx = fx - ax, sy2 = fy - ay;
        state.px += cy * (sx - run.shiftX) - sy * (sy2 - run.shiftY);
        state.py += sy * (sx - run.shiftX) + cy * (sy2 - run.shiftY);
        run.shiftX = sx; run.shiftY = sy2;
        Y.LEGS.forEach(function (L, li) {
          const n = Y.Robot.legs[L.id];
          const a = axles[L.id];
          if (onGround(L)) assign(n, Y.Motion.ik(L, a[0], a[1], a[2]));
          else assign(n, [run.holdQ[li * 3], run.holdQ[li * 3 + 1], run.holdQ[li * 3 + 2]]);
          const o = rot(a);
          n.contact = onGround(L);
          n.footWorld = [state.px + cy * o[0] - sy * o[1],
                         state.py + sy * o[0] + cy * o[1],
                         state.z + o[2] - WHEEL_R];
          if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
          nat.figAxle[L.id] = null;
        });
      };

      if (t < t1) {                                 // charge sur l'appui
        phase = "charge";
        const sc = smooth(t / t1);
        state.z = base + ride * (1 - 0.12 * sc) + WHEEL_R;
        state.pitch = 0; state.roll = 0;
        place(function (L, h) { return h + WHEEL_R; });
      } else {
        if (!run.holdQ) {                           // on fige la pose une fois
          run.holdQ = captureQ();
          run.holdZ = base + WHEEL_R - state.z;
          run.shiftX = 0; run.shiftY = 0;
          run.prevA = {};
        }
        if (t < t2) {
          phase = f.axis === "roll" ? "bascule" : "cabrage";
          const k = smooth((t - t1) / f.rise);
          tilt(k, f.angle * k);
        } else if (t < t3) {
          phase = "tenue";
          run.holdT += dt;
          // tenue maintenue : tant qu'on n'a pas redemandé, le chrono de la
          // figure ne s'écoule pas — le robot reste dressé indéfiniment
          if (f.sustain && !run.release) run.t = t2;
          tilt(1, f.angle + Math.sin(run.holdT * 11) * f.wobble);
        } else {
          const sd = smooth((t - t3) / f.drop);
          if (sd < 0.65) {                          // on redescend, appui tenu
            phase = "reprise";
            const k = 1 - sd / 0.65;
            tilt(k, f.angle * k);
          } else {                                  // puis fondu vers l'appui normal
            phase = "reprise";
            const u = smooth((sd - 0.65) / 0.35);
            state.roll = 0; state.pitch = 0;
            state.z = base + ride * lerp(0.88, 1.0, u) + WHEEL_R;
            Y.LEGS.forEach(function (L, li) {
              const n = Y.Robot.legs[L.id];
              const nx = L.x, ny = L.y + L.m * K.abadPlane;
              const wx = state.px + cy * nx - sy * ny;
              const wy = state.py + sy * nx + cy * ny;
              const h = terrainAt(wx, wy);
              const target = constrain(L, [nx, ny, h + WHEEL_R - state.z]);
              const g = Y.Motion.ik(L, target[0], target[1], target[2]);
              assign(n, [0, 1, 2].map(function (i) {
                return lerp(run.holdQ[li * 3 + i], g[i], u);
              }));
              n.contact = true;
              n.footWorld = [wx, wy, h];
              if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
              nat.figAxle[L.id] = null;
            });
          }
        }
      }
    } else if (f.kind === "spin") {
      const t1 = f.arm, t2 = t1 + f.spin;
      if (t < t1) {
        phase = "appui";
        const s = smooth(t / t1);
        state.z = base + ride * (1 - 0.10 * s) + WHEEL_R;
        state.roll = lerp(0, f.lean * 0.4, s);
      } else if (t < t2) {
        phase = "vrille";
        const s = (t - t1) / f.spin;
        state.yaw = run.yaw0 + 2 * Math.PI * f.turns * smoother(s);
        state.roll = f.lean * Math.sin(Math.PI * s);
        state.z = base + ride * 0.90 + WHEEL_R;
        nat.wz = 2 * Math.PI * f.turns / f.spin;      // pour la rotation des roues
      } else {
        phase = "stabilisation";
        const s = smooth((t - t2) / f.settle);
        state.yaw = run.yaw0 + 2 * Math.PI * f.turns;
        state.roll = lerp(f.lean * 0.2, 0, s);
        state.z = base + ride * (0.90 + 0.10 * s) + WHEEL_R;
        nat.wz = lerp(nat.wz, 0, Math.min(1, dt * 6));
      }
      place(function (L, h) { return h + WHEEL_R; });
    } else if (f.kind === "slide") {
      /**
       * Powerslide : la caisse pivote en travers pendant que la quantité de
       * mouvement continue tout droit. Les pneus chassent — la vitesse de
       * rotation des roues n'est plus que la projection de la trajectoire sur
       * le cap — et le robot s'incline dans le dérapage avant de s'arrêter.
       */
      const t1 = f.entry, t2 = t1 + f.slide;
      const sgn = f.side || 1;
      const sweep = f.yawSweep * sgn;
      if (t < t1) {
        phase = "mise en travers";
        const s = smooth(t / t1);
        state.yaw = run.yaw0 + sweep * 0.25 * s;
        state.roll = lerp(0, f.lean * sgn * 0.5, s);
        state.z = base + ride * (1 - 0.06 * s) + WHEEL_R;
      } else if (t < t2) {
        phase = "dérapage";
        const s = smooth((t - t1) / f.slide);
        state.yaw = run.yaw0 + sweep * (0.25 + 0.75 * s);
        state.roll = f.lean * sgn * (0.5 + 0.5 * Math.sin(Math.PI * s));
        state.z = base + ride * 0.94 + WHEEL_R;
        // les pneus chassent en travers : la vitesse tombe vite
        if (run.carry) {
          const sp = Math.hypot(run.carry[0], run.carry[1]);
          const ns = Math.max(0, sp - f.decel * dt);
          if (sp > 1e-6) { run.carry[0] *= ns / sp; run.carry[1] *= ns / sp; }
        }
      } else {
        phase = "arrêt";
        const s = smooth((t - t2) / f.settle);
        state.yaw = run.yaw0 + sweep;
        state.roll = lerp(f.lean * sgn * 0.5, 0, s);
        state.z = base + ride * (0.94 + 0.06 * s) + WHEEL_R;
        if (run.carry) { run.carry[0] *= 1 - Math.min(1, dt * 6); run.carry[1] *= 1 - Math.min(1, dt * 6); }
      }
      // la roue ne tourne plus qu'à la projection de la trajectoire sur le cap
      if (run.carry) {
        nat.vx = run.carry[0] * Math.cos(state.yaw) + run.carry[1] * Math.sin(state.yaw);
      }
      place(function (L, h) { return h + WHEEL_R; });

    } else {                                          // saut et salto
      const t1 = f.crouch, t2 = t1 + f.push, t3 = t2 + f.flight, t4 = t3 + f.land;
      const takeoff = base + ride + WHEEL_R;
      // `sense` vaut +1 pour une rotation arrière, -1 pour une rotation avant :
      // il retourne le chargement, la poussée et la rotation d'un seul coup.
      const sense = f.sense || 1;
      const armPitch = f.turns ? -0.10 * sense : 0.04;
      const offPitch = f.turns ? -0.50 * sense : -0.14;
      // une figure « tourne » dès qu'elle pivote autour d'un axe : tangage
      // (saltos avant et arrière) ou roulis (saltos latéraux)
      const spinning = !!(f.turns || f.rollTurns);
      /**
       * Sol de référence de la caisse pendant les phases au sol.
       *
       * Il suit le relief RÉEL sous le robot — c'est ce qui permet de prendre
       * l'élan sur une rampe, de monter avec elle et de sauter depuis sa
       * lèvre — mais filtré : une rampe est découpée en tranches de 50 mm, et
       * suivre leur escalier brut faisait sauter la caisse de 13 mm d'une
       * image à l'autre. Le premier appel se cale sur la hauteur d'où l'on
       * vient, pour que l'entrée en figure ne claque pas non plus.
       */
      const groundRef = function () {
        const here = terrainAt(state.px, state.py);
        if (run.groundRef === null) run.groundRef = here;
        run.groundRef = lerp(run.groundRef, here, Math.min(1, dt * 12));
        return run.groundRef;
      };
      const bodyZ = function (k) {
        const want = groundRef() + ride * k + WHEEL_R;
        if (run.entryZ === null) return want;
        const e = smooth(Math.min(1, t / Math.max(f.crouch * 0.6, 1e-3)));
        return lerp(run.entryZ, want, e);
      };

      if (t < t1) {
        phase = "armement";
        const s = smooth(t / t1);
        state.z = bodyZ(lerp(1, f.crouchZ, s));
        state.pitch = lerp(0, armPitch, s);
        state.roll = lerp(0, -0.10 * (f.rollTurns || 0), s);
        place(function (L, h) { return h + WHEEL_R; });
      } else if (t < t2) {
        phase = "poussée";
        const s = smooth((t - t1) / f.push);
        state.z = bodyZ(lerp(f.crouchZ, 1.18, s));
        state.pitch = lerp(armPitch, offPitch, s);
        state.roll = lerp(-0.10 * (f.rollTurns || 0), -0.40 * (f.rollTurns || 0), s);
        place(function (L, h) { return h + WHEEL_R; });
        run.takeoffZ = state.z;                 // la lèvre : d'où part le vol
      } else if (t < t3) {
        phase = spinning ? "vol" : "envol";
        const tf = t - t2;
        const s = tf / f.flight;
        // vol balistique depuis la hauteur réellement atteinte au décollage
        state.z = (run.takeoffZ === null ? takeoff : run.takeoffZ)
          + f.vz * tf - 0.5 * G_ACC * tf * tf;
        if (f.turns) {
          state.pitch = offPitch + (-2 * Math.PI * f.turns * sense - offPitch) * smoother(s);
          if (f.twist) {                              // vrille + gîte du McTwist
            state.yaw = run.yaw0 + 2 * Math.PI * f.twist * smoother(s);
            state.roll = Math.sin(Math.PI * s) * f.cork;
          }
        } else if (f.rollTurns) {
          const r0 = -0.40 * f.rollTurns;
          state.roll = r0 + (2 * Math.PI * f.rollTurns - r0) * smoother(s);
          state.pitch = lerp(0, 0, s);
        } else {
          state.pitch = lerp(-0.14, 0.10, smooth(s));
        }
        if (spinning) {
          // en salto, la caisse tourne : les jambes doivent être fixées dans
          // SON repère, sinon elles tournent autour d'elle à chaque image
          if (!run.takeoffQ) run.takeoffQ = captureQ();
          if (s < 0.45) poseFromQ(run.takeoffQ, POSE.tuck, smooth(s / 0.45));
          else poseMixQ(POSE.tuck, POSE.reach, smooth((s - 0.45) / 0.55));
          Y.LEGS.forEach(function (L) {
            const n = Y.Robot.legs[L.id];
            if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
            nat.figAxle[L.id] = null;              // on repartira du réel au poser
          });
        } else {
          // saut à plat : les roues pendent, se rentrent au sommet, se tendent
          const arc = Math.sin(Math.PI * clamp(s, 0, 1));
          const hang = lerp(ride + WHEEL_R, ride * 0.5, arc);
          place(function () { return state.z - hang; }, function () { return false; });
        }
      } else if (t < t4) {
        phase = "réception";
        const s = smooth((t - t3) / f.land);
        // On se reçoit sur le sol qui est SOUS le robot, pas sur celui d'où
        // il a décollé. C'est ce qui permet de partir de la lèvre d'une rampe
        // et de retomber sur le plat : le vol reste balistique depuis le
        // point haut, et la réception absorbe le reste de la chute.
        if (run.landZ0 === null) run.landZ0 = state.z;
        state.z = lerp(run.landZ0, groundRef() + ride * 0.80 + WHEEL_R, s);
        state.pitch = spinning ? lerp(0, 0.10, s) : lerp(0.10, 0.06, s);
        // un tour de roulis ramène la caisse à l'endroit : 2π et 0, c'est la
        // même orientation, on recale sans dérouler la rotation à l'envers
        if (f.rollTurns) state.roll = 0;
        if (f.twist) {                                // on remet la gîte à plat
          state.yaw = run.yaw0 + 2 * Math.PI * f.twist;
          state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
          // Un 540 tourne le robot d'un demi-tour net : il retombe face à
          // l'arrière de sa trajectoire. Au toucher, les pneus sont donc
          // traînés en arrière — c'est le « fakie » du skate, et le robot
          // continue sur son erre, roues à l'envers.
          if (!run.fakie) {
            run.fakie = true;
            nat.vx = -nat.vx;
            nat.dir = -nat.dir;
          }
        }
        if (spinning) {
          // on ouvre depuis la pose de vol vers la pose d'appui : sans ce
          // fondu, le passage vol -> sol coûte 190 rad/s en une image
          Y.LEGS.forEach(function (L) {
            const n = Y.Robot.legs[L.id];
            const nx = L.x, ny = L.y + L.m * K.abadPlane;
            const wx = state.px + cy * nx - sy * ny;
            const wy = state.py + sy * nx + cy * ny;
            const dx = wx - state.px, dy = wy - state.py;
            const level = [cy * dx + sy * dy, -sy * dx + cy * dy,
              terrainAt(wx, wy) + WHEEL_R - state.z];
            const target = constrain(L, levelToBody(level, state.roll, state.pitch, 0));
            const ground = Y.Motion.ik(L, target[0], target[1], target[2]);
            const air = poseFor(L, POSE.reach);
            assign(n, [0, 1, 2].map(function (i) { return lerp(air[i], ground[i], s); }));
            n.contact = s > 0.4;
            n.footWorld = [wx, wy, terrainAt(wx, wy)];
            if (n.wheel) n.wheel.rotation.y = nat.spin[L.id];
            nat.figAxle[L.id] = null;
          });
        } else {
          place(function (L, h) { return h + WHEEL_R; }, function () { return s > 0.4; });
        }
      } else {
        phase = "stabilisation";
        const s = smooth((t - t4) / f.recover);
        state.z = groundRef() + ride * lerp(0.80, 1.0, s) + WHEEL_R;
        state.pitch = lerp(0.10, 0, s);
        state.roll = lerp(state.roll, 0, Math.min(1, dt * 8));
        place(function (L, h) { return h + WHEEL_R; });
      }
    }

    Y.Stunt.phase = phase;
    Y.Stunt.progress = clamp(t / f.duration, 0, 1);

    if (t >= f.duration) {
      state.pitch = 0; state.roll = 0;
      if (f.kind === "spin") { state.yaw = run.yaw0 + 2 * Math.PI * f.turns; nat.wz = 0; }
      if (f.kind === "slide") { state.yaw = run.yaw0 + f.yawSweep * (f.side || 1); nat.vx = 0; }
      if (f.twist) state.yaw = run.yaw0 + 2 * Math.PI * f.twist;
      state.z = terrainAt(state.px, state.py) + ride + WHEEL_R;
      nat.zBody = state.z; nat.vz = 0;
      run.carry = null;
      Y.LEGS.forEach(function (L) { nat.wheelZ[L.id] = null; nat.wstep[L.id] = null; });
      Y.Stunt.stop(true);
    }
  }

  Y.Stunt = {
    figures: FIGURES,
    active: null, phase: "", progress: 0, listeners: [],
    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { const s = this; this.listeners.forEach(function (fn) { fn(s); }); },
    label: function (name) { const f = FIGURES[name || this.active]; return f ? f.label : ""; },
    duration: function (name) { const f = FIGURES[name || this.active]; return f ? f.duration : 0; },
    info: function (name) {
      const f = FIGURES[name || this.active];
      if (!f) return null;
      return { label: f.label, flight: f.flight, apex: f.apex, duration: f.duration,
        turns: f.turns, twist: f.twist, vz: f.vz };
    },
    /**
     * Dénivelé sous les quatre roues, en mètres.
     *
     * Une tenue fait pivoter la caisse autour d'une ligne de contact : ça
     * suppose que cette ligne est horizontale. Sur une transition de quarter
     * pipe ou en plein escalier elle ne l'est pas, et forcer la géométrie
     * coûtait jusqu'à 132 rad/s sur la première image.
     */
    levelUnderWheels: function () {
      const st = Y.Motion.state;
      const cy0 = Math.cos(st.yaw), sy0 = Math.sin(st.yaw);
      let lo = Infinity, hi = -Infinity;
      Y.LEGS.forEach(function (L) {
        const nx = L.x, ny = L.y + L.m * K.abadPlane;
        const h = terrainAt(st.px + cy0 * nx - sy0 * ny, st.py + sy0 * nx + cy0 * ny);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      });
      return hi - lo;
    },

    start: function (name) {
      const f = FIGURES[name];
      if (!f) return false;
      if ((f.mode || "pattes") !== Y.Motion.state.mode) return false;
      if (f.kind === "tilt" && this.levelUnderWheels() > 0.03) return "pente";
      run.fig = f; run.t = 0; run.takeoffQ = null; run.entryQ = captureQ();
      run.holdQ = null; run.shiftX = 0; run.shiftY = 0;
      run.fakie = false; run.holdT = 0; run.release = false; run.landZ0 = null; run.takeoffZ = null;
      run.groundRef = null; run.entryZ = Y.Motion.state.z;
      // on amorce le limiteur de débattement sur la position réelle des pieds :
      // sinon la première image saute d'un rayon de roue et coûte 57 rad/s
      Y.LEGS.forEach(function (L) {
        const n = Y.Robot.legs[L.id];
        n.foot.getWorldPosition(n.world);
        nat.figAxle[L.id] = n.world.z - Y.Motion.state.z;
      });
      run.carry = (f.twist || f.kind === "slide")
        ? [nat.vx * Math.cos(Y.Motion.state.yaw), nat.vx * Math.sin(Y.Motion.state.yaw)]
        : null;
      run.yaw0 = Y.Motion.state.yaw;
      // Sol de référence : sous le centre de caisse en général, mais sous les
      // roues porteuses pour une tenue — c'est sur elles que tout s'appuie.
      const st = Y.Motion.state;
      if (f.kind === "tilt") {
        const on = f.axis === "roll"
          ? function (L) { return L.m < 0; }
          : function (L) { return L.f < 0; };
        const cy0 = Math.cos(st.yaw), sy0 = Math.sin(st.yaw);
        let h = 0, n0 = 0;
        Y.LEGS.forEach(function (L) {
          if (!on(L)) return;
          const nx = L.x, ny = L.y + L.m * K.abadPlane;
          h += terrainAt(st.px + cy0 * nx - sy0 * ny, st.py + sy0 * nx + cy0 * ny);
          n0++;
        });
        run.ground = h / n0;
      } else {
        run.ground = terrainAt(st.px, st.py);
      }
      this.active = name; this.phase = "armement"; this.progress = 0;
      this.emit();
      return true;
    },
    /**
     * Termine la figure. `done` est vrai quand elle est allée à son terme —
     * elle a alors déjà remis le robot d'aplomb elle-même.
     *
     * Une interruption, elle, peut survenir en pleine bascule : sans remise
     * à plat le générateur d'allure repartait d'un tronc à 83°.
     */
    stop: function (done) {
      if (run.fig && !done) {
        const st = Y.Motion.state;
        st.roll = 0; st.pitch = 0;
        st.z = terrainAt(st.px, st.py) + (st.mode === "roues"
          ? st.height * 0.92 + WHEEL_R : st.height);
        nat.zBody = st.z; nat.vz = 0;
        Y.LEGS.forEach(function (L) {
          nat.plant[L.id] = null; nat.lift[L.id] = null; nat.land[L.id] = null;
          nat.prevFoot[L.id] = null; nat.clear[L.id] = 0;
          nat.wheelZ[L.id] = null; nat.wstep[L.id] = null; nat.figAxle[L.id] = null;
        });
        Y.Motion.blendFrom(0.3);
      }
      run.fig = null; this.active = null; this.phase = ""; this.progress = 0;
      this.emit();
    },

    /** Une tenue est-elle en cours, en attente qu'on la relâche ? */
    sustaining: function () {
      return !!(run.fig && run.fig.sustain && !run.release && this.phase === "tenue");
    },

    /** Relâche la tenue : le robot repose ses roues et se stabilise. */
    release: function () {
      if (!run.fig || !run.fig.sustain || run.release) return false;
      run.release = true;
      run.t = run.fig.arm + run.fig.rise + run.fig.hold;   // on enchaîne la reprise
      return true;
    },
    step: function (dt, state) {
      if (!run.fig) return false;
      if (run.fig.mode === "roues") stepWheelFigure(dt, state);
      else stepFigure(dt, state);
      return true;
    },

    /** Figures disponibles pour le train de propulsion courant. */
    forMode: function (mode) {
      return Object.keys(FIGURES).filter(function (k) {
        return (FIGURES[k].mode || "pattes") === mode;
      });
    }
  };

  Y.Natural = {
    profiles: PROFILES,
    state: nat,
    step: stepNatural,
    stepWheels: stepWheels,
    wheelRadius: WHEEL_R,
    setProfile: function (name) { nat.profile = PROFILES[name] || PROFILES.souple; },
    reset: function () {
      nat.vx = nat.vy = nat.wz = nat.ax = 0;
      nat.dir = 1;                                   // on repart en marche avant
      const g = Y.GAITS[Y.Motion.state.gait] || Y.GAITS.trot;
      nat.duty = g.duty; nat.stance = g.stance;
      nat.trotMix = g.name === "walk" ? 0 : 1;
      nat.air = false; nat.vz = 0;
      nat.zBody = Y.Motion.state.z || 0.25; nat.zTarget = nat.zBody;
      nat.track = nat.profile.track; nat.heightBias = nat.profile.heightBias;
      nat.hindReach = nat.profile.hindReach; nat.swingScale = nat.profile.swingScale;
      Y.LEGS.forEach(function (L) {
        nat.plant[L.id] = null; nat.lift[L.id] = null; nat.land[L.id] = null;
        nat.clear[L.id] = 0; nat.prevFoot[L.id] = null; nat.wheelZ[L.id] = null;
        nat.wstep[L.id] = null;
        nat.off[L.id] = g.off[L.id] !== undefined ? g.off[L.id] : 0;
        nat.jit[L.id] = 0; nat.lastPh[L.id] = 0;
      });
    },
    setAuto: function (on) { nat.auto = !!on; },
    isAuto: function () { return nat.auto; },
    airborne: function () { return nat.air; },
    lastFlight: function () { return nat.lastAir; },
    wheelWarning: function () { return nat.wheelWarn; }
  };
})(window.YLO);
