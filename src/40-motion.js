/* =====================================================================
   YLO-2 — cinématique, allures et lecture de simulation
   Trois sources possibles pour les 12 angles :
     · interne  — générateur d'allure du navigateur (type CHAMP)
     · fichier  — trajectoire produite par le simulateur Python (sim/)
     · direct   — serveur de simulation local, en flux SSE
   ===================================================================== */
(function (Y) {
  "use strict";
  const K = Y.K;

  const state = {
    gait: "trot", vx: 0.12, vy: 0, wz: 0, height: 0.25, swing: 0.04,
    phase: 0, px: 0, py: 0, yaw: 0, roll: 0, pitch: 0, z: 0.25, sway: 0, yawWag: 0,
    t: 0,
    style: "souple",              // « brut », « souple » ou « felin »
    mode: "pattes",               // « pattes » ou « roues »
    source: "internal", frozen: false
  };

  /* ---------- cinématique inverse d'une patte ---------- */
  function ik(L, tx, ty, tz) {
    const x = tx - L.x, y = ty - L.y, z = tz - K.legZ;   // repère hanche
    const off = L.m * K.abadPlane;        // le joint KFE décale le plan sagittal
    const r2 = y * y + z * z;
    // plancher non nul : près de l'axe d'abduction, la racine saturerait sec
    const zp = -Math.sqrt(Math.max(r2 - off * off, 0.0004));
    const q1 = Math.atan2(z, y) - Math.atan2(zp, off);
    const X = -x, Z = -zp;                                // plan sagittal
    let D = Math.hypot(X, Z);
    const dmax = (K.L1 + K.L2) * 0.999, dmin = Math.abs(K.L1 - K.L2) + 0.02;
    D = Math.min(Math.max(D, dmin), dmax);
    const c3 = (D * D - K.L1 * K.L1 - K.L2 * K.L2) / (2 * K.L1 * K.L2);
    const q3 = -Math.acos(Math.min(1, Math.max(-1, c3)));
    const q2 = Math.atan2(X, Z) - Math.atan2(K.L2 * Math.sin(q3), K.L1 + K.L2 * Math.cos(q3));
    return [q1, q2, q3];
  }

  function smooth(s) { return s * s * (3 - 2 * s); }

  /* ---------- générateur d'allure interne ---------- */
  function stepInternal(dt) {
    const G = Y.GAITS[state.gait];
    const moving = state.gait !== "stand" && !state.frozen;
    const cycle = G.stance / G.duty;
    if (moving) {
      state.phase = (state.phase + dt / cycle) % 1;
      state.yaw += state.wz * dt;
      state.px += (state.vx * Math.cos(state.yaw) - state.vy * Math.sin(state.yaw)) * dt;
      state.py += (state.vx * Math.sin(state.yaw) + state.vy * Math.cos(state.yaw)) * dt;
    }

    const under = Y.Terrain ? Y.Terrain.heightAt(state.px, state.py) : 0;
    state.z = under + state.height + (moving ? Math.sin(state.phase * Math.PI * 4) * 0.006 : 0);
    state.pitch = moving ? Math.sin(state.phase * Math.PI * 4 + 1.1) * 0.018 : 0;
    state.roll = (moving && (state.gait === "pace" || state.gait === "walk"))
      ? Math.sin(state.phase * Math.PI * 2) * 0.03 : 0;

    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      const nx = L.x, ny = L.y + L.m * K.abadPlane;
      const vfx = state.vx - state.wz * ny;             // v + ω × r
      const vfy = state.vy + state.wz * nx;
      const sweepX = vfx * G.stance, sweepY = vfy * G.stance;
      const ph = (state.phase + G.off[L.id]) % 1;

      const ground = Y.Terrain ? Y.Terrain.heightAt(
        state.px + Math.cos(state.yaw) * nx - Math.sin(state.yaw) * ny,
        state.py + Math.sin(state.yaw) * nx + Math.cos(state.yaw) * ny) : 0;
      let fx = nx, fy = ny, fz = ground - state.z, contact = true;
      if (moving) {
        if (ph < G.duty) {
          const s = ph / G.duty;
          fx = nx + sweepX * (0.5 - s);
          fy = ny + sweepY * (0.5 - s);
        } else {
          const s = (ph - G.duty) / (1 - G.duty), e = smooth(s);
          fx = nx + sweepX * (-0.5 + e);
          fy = ny + sweepY * (-0.5 + e);
          fz = ground - state.z + Math.sin(Math.PI * s) * state.swing;
          contact = false;
        }
      }
      n.q = ik(L, fx, fy, fz);
      n.contact = contact;
      n.phase = ph;
    });
  }

  /* ---------- lecture d'une trajectoire Python ---------- */
  const play = {
    traj: null, t: 0, speed: 1, playing: true, name: "", dt: 0.02, duration: 0,
    listeners: [],

    load: function (data, name) {
      if (!data || !Array.isArray(data.frames) || !data.frames.length) {
        throw new Error("trajectoire vide ou format inconnu");
      }
      if (data.format && String(data.format).indexOf("ylo2.trajectory") !== 0) {
        throw new Error("format « " + data.format + " » non reconnu");
      }
      this.traj = data;
      this.dt = data.dt || 0.02;
      this.duration = data.frames[data.frames.length - 1].t || (data.frames.length - 1) * this.dt;
      this.name = name || data.source || "trajectoire";
      this.t = 0; this.playing = true;
      state.source = "file";
      this.emit();
      return this;
    },

    clear: function () {
      this.traj = null; state.source = "internal"; this.emit();
    },

    emit: function () { this.listeners.forEach(function (fn) { fn(play); }); },
    onChange: function (fn) { this.listeners.push(fn); },

    frameAt: function (t) {
      const f = this.traj.frames;
      const raw = t / this.dt;
      const i = Math.min(f.length - 1, Math.max(0, Math.floor(raw)));
      const j = Math.min(f.length - 1, i + 1);
      const u = Math.min(1, Math.max(0, raw - i));
      return { a: f[i], b: f[j], u: u };
    },

    step: function (dt) {
      if (!this.traj) return;
      if (this.playing) {
        this.t += dt * this.speed;
        if (this.t > this.duration) this.t = 0;          // boucle
      }
      const s = this.frameAt(this.t);
      const a = s.a, b = s.b, u = s.u;
      Y.LEGS.forEach(function (L, li) {
        const n = Y.Robot.legs[L.id];
        n.q = [0, 1, 2].map(function (k) {
          const ia = li * 3 + k;
          return a.q[ia] + (b.q[ia] - a.q[ia]) * u;
        });
        n.contact = (a.contact ? a.contact[li] : 1) > 0.5;
        n.phase = a.phase !== undefined ? a.phase : 0;
      });
      const base = a.base || [0, 0, state.height, 0, 0, 0];
      const nb = b.base || base;
      state.px = base[0] + (nb[0] - base[0]) * u;
      state.py = base[1] + (nb[1] - base[1]) * u;
      state.z = base[2] + (nb[2] - base[2]) * u;
      state.roll = base[3]; state.pitch = base[4];
      state.yaw = base[5] + (nb[5] - base[5]) * u;
    }
  };

  /* ---------- liaison directe avec le serveur de simulation ---------- */
  const live = {
    es: null, status: "offline", last: null, url: "", listeners: [],
    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { const s = this; this.listeners.forEach(function (fn) { fn(s); }); },

    available: function () { return location.protocol === "http:" || location.protocol === "https:"; },

    connect: function (base) {
      const self = this;
      if (!this.available()) { this.status = "indisponible"; this.emit(); return; }
      this.disconnect();
      this.url = (base || "") + "/api/stream";
      this.status = "connexion";
      this.emit();
      try {
        this.es = new EventSource(this.url);
      } catch (e) {
        this.status = "erreur"; this.emit(); return;
      }
      this.es.onopen = function () { self.status = "connecté"; state.source = "live"; self.emit(); };
      this.es.onerror = function () { self.status = "erreur"; self.emit(); };
      this.es.onmessage = function (ev) {
        try { self.last = JSON.parse(ev.data); } catch (e) { /* trame partielle */ }
      };
    },

    disconnect: function () {
      if (this.es) { this.es.close(); this.es = null; }
      if (state.source === "live") state.source = "internal";
      this.status = "offline"; this.emit();
    },

    send: function (cmd) {
      if (!this.available()) return Promise.resolve(false);
      return fetch("/api/cmd", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd)
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    },

    step: function () {
      const s = this.last;
      if (!s || !s.q) return;
      Y.LEGS.forEach(function (L, li) {
        const n = Y.Robot.legs[L.id];
        n.q = [s.q[li * 3], s.q[li * 3 + 1], s.q[li * 3 + 2]];
        n.contact = s.contact ? s.contact[li] > 0.5 : true;
        n.phase = s.phase || 0;
      });
      if (s.base) {
        state.px = s.base[0]; state.py = s.base[1]; state.z = s.base[2];
        state.roll = s.base[3]; state.pitch = s.base[4]; state.yaw = s.base[5];
      }
      if (s.phase !== undefined) state.phase = s.phase;
    }
  };

  /* ---------- fondu de pose ----------
     Changer de style replace les appuis : sans fondu, le premier pas demande
     des dizaines de rad/s aux genoux. On interpole depuis la pose courante. */
  const morph = { k: 1, dur: 0.3, from: null };

  function blendFrom(seconds) {
    morph.from = Y.LEGS.map(function (L) { return Y.Robot.legs[L.id].q.slice(); });
    morph.dur = seconds || 0.3;
    morph.k = 0;
  }

  function applyMorph(dt) {
    if (morph.k >= 1 || !morph.from) return;
    morph.k = Math.min(1, morph.k + dt / morph.dur);
    const e = smooth(morph.k);
    Y.LEGS.forEach(function (L, i) {
      const n = Y.Robot.legs[L.id];
      const from = morph.from[i];
      n.q = n.q.map(function (v, k) { return from[k] + (v - from[k]) * e; });
    });
  }

  /* ---------- pas de simulation, quelle que soit la source ---------- */
  function step(dt) {
    state.t += dt;
    /* La danse passe avant tout le reste : elle écrit elle-même l'assiette,
       la hauteur de caisse et les quatre appuis. Ce n'est pas une consigne de
       marche que le générateur d'allure interpréterait — c'est une
       chorégraphie de pieds, et deux générateurs sur les mêmes pattes se
       battraient. */
    if (Y.Dance && Y.Dance.dancing() && state.source === "internal") {
      Y.Dance.pose(dt, state);
    } else if (Y.Stunt && Y.Stunt.active && state.source === "internal") {
      Y.Stunt.step(dt, state);
    } else if (state.source === "file") {
      play.step(dt);
    } else if (state.source === "live") {
      live.step();
    } else if (state.mode === "roues" && Y.Natural && !state.frozen) {
      Y.Natural.stepWheels(dt, state);
    } else if (state.style !== "brut" && Y.Natural && !state.frozen) {
      Y.Natural.step(dt, state);
    } else {
      state.sway = 0;
      state.yawWag = 0;
      stepInternal(dt);
    }

    applyMorph(dt);

    // application aux articulations
    Y.LEGS.forEach(function (L) {
      const n = Y.Robot.legs[L.id];
      n.hip.rotation.x = n.q[0];
      n.upper.rotation.y = n.q[1];
      n.lower.rotation.y = n.q[2];
    });
    // le report de masse déplace la caisse, pas les appuis
    const sway = state.source === "internal" ? (state.sway || 0) : 0;
    Y.Robot.root.position.set(
      state.px - Math.sin(state.yaw) * sway,
      state.py + Math.cos(state.yaw) * sway,
      state.z);
    Y.Robot.root.rotation.set(state.roll, state.pitch, state.yaw + (state.yawWag || 0), "ZYX");
  }

  function outOfLimits(q) {
    return [
      q[0] < K.haaMin || q[0] > K.haaMax,
      false,
      q[2] < K.kfeMin || q[2] > K.kfeMax
    ];
  }

  Y.Motion = { state: state, ik: ik, step: step, play: play, live: live,
    outOfLimits: outOfLimits, smooth: smooth, blendFrom: blendFrom };
})(window.YLO);
