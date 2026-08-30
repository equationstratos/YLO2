/* =====================================================================
   YLO-2 — enregistrer un run, le rejouer, l'envoyer

   Ce qu'on enregistre n'est pas une vidéo mais ce que le PILOTE a fait :
   image par image, la consigne de vitesse, de rotation, de hauteur et de
   frein, plus les figures déclenchées. La physique du robot est une
   fonction pure de (état, consignes, pas de temps) : en redonnant la même
   suite de pas de temps et les mêmes consignes depuis le même état de
   départ, on rejoue exactement le même run. C'est la raison pour laquelle
   le pas de temps fait partie de la prise — le navigateur ne rend pas deux
   fois de suite à la même cadence, et une prise rejouée à 60 images/s là
   où elle a été faite à 45 ne donnerait pas le même saut.

   La prise est un fichier JSON : on l'exporte, on le range, on le renvoie.
   ===================================================================== */
(function (Y) {
  "use strict";

  const VERSION = 1;
  /* Quatre décimales sur les consignes, six sur le pas de temps. Ce n'est
     pas de la coquetterie : le pas de temps s'ACCUMULE. Arrondi au dixième de
     milliseconde, une prise de 900 images dérivait de 45 ms sur sa durée
     totale, soit 36 mm de position à 2 m/s — assez pour rater une lèvre. */
  const r3 = function (v) { return Math.round(v * 10000) / 10000; };
  const rdt = function (v) { return Math.round(v * 1e6) / 1e6; };

  const S = {
    mode: "idle",          // idle · rec · play
    take: null,            // la prise en cours d'écriture ou de lecture
    i: 0,                  // image courante en relecture
    pending: [],           // événements de l'image en cours d'écriture
    listeners: []
  };

  function emit() { S.listeners.forEach(function (fn) { fn(S); }); }

  /* --- capter les événements discrets ---
     Une figure et une figure en l'air ne sont pas des consignes continues :
     elles arrivent sur une image et une seule. On enveloppe donc les trois
     portes d'entrée plutôt que de demander à chaque appelant de prévenir —
     ainsi la manette, le clavier, les boutons de l'interface et la session
     auto sont enregistrés de la même façon, sans que rien ne le sache. */
  function wrap() {
    const st = Y.Stunt, nat = Y.Natural;
    const start0 = st.start, release0 = st.release, trick0 = nat.trick;
    st.start = function (name, charge, hold) {
      const ok = start0.apply(st, arguments);
      if (S.mode === "rec" && ok && ok !== "pente") S.pending.push(["fig", name, !!charge]);
      return ok;
    };
    st.release = function () {
      if (S.mode === "rec" && st.active) S.pending.push(["release"]);
      return release0.apply(st, arguments);
    };
    nat.trick = function (id) {
      const ok = trick0.apply(nat, arguments);
      if (S.mode === "rec" && ok) S.pending.push(["trick", id]);
      return ok;
    };
  }

  function snapshot() {
    const st = Y.Motion.state;
    return {
      mode: st.mode, gait: st.gait, px: r3(st.px), py: r3(st.py), z: r3(st.z),
      yaw: r3(st.yaw), roll: r3(st.roll), pitch: r3(st.pitch),
      height: r3(st.height), clearance: r3(st.clearance || 0),
      free: !!(Y.Natural.state && Y.Natural.state.freeRoll)
    };
  }

  function restore(s) {
    const st = Y.Motion.state;
    st.mode = s.mode; st.px = s.px; st.py = s.py; st.z = s.z;
    st.yaw = s.yaw; st.roll = s.roll; st.pitch = s.pitch;
    st.height = s.height; if (s.clearance) st.clearance = s.clearance;
    st.vx = 0; st.wz = 0;
    Y.Stunt.stop(false);
    Y.Natural.reset();
    if (Y.Natural.setFreeRoll) Y.Natural.setFreeRoll(!!s.free);
    Y.Motion.blendFrom(0.3);
  }

  Y.Record = {
    state: S,
    onChange: function (fn) { S.listeners.push(fn); },

    /** Prise en cours d'écriture ? de lecture ? */
    recording: function () { return S.mode === "rec"; },
    replaying: function () { return S.mode === "play"; },

    start: function () {
      if (S.mode !== "idle") return false;
      S.take = {
        format: "ylo2-run", version: VERSION,
        date: new Date().toISOString(),
        terrain: Y.Terrain.current.id,
        start: snapshot(),
        frames: [], events: []
      };
      S.pending = []; S.mode = "rec"; emit();
      return true;
    },

    stop: function () {
      if (S.mode === "idle") return;
      if (S.mode === "play") { S.i = 0; }
      S.mode = "idle"; emit();
    },

    play: function (take) {
      const t = take || S.take;
      if (!t || !t.frames.length) return false;
      if (t.terrain && Y.Terrain.current.id !== t.terrain) Y.Terrain.set(t.terrain);
      restore(t.start);
      S.take = t; S.i = 0; S.mode = "play"; emit();
      return true;
    },

    /**
     * Pas de temps de l'image : celui du navigateur en enregistrement,
     * celui de la PRISE en relecture. C'est ce qui rend la relecture
     * identique et non seulement ressemblante.
     */
    frame: function (dt) {
      if (S.mode !== "play") return dt;
      const f = S.take.frames[S.i];
      return f ? f[0] : dt;
    },

    /** En relecture : écrire les consignes de l'image et lâcher ses figures. */
    apply: function () {
      if (S.mode !== "play") return;
      const f = S.take.frames[S.i];
      if (!f) { this.stop(); return; }
      const st = Y.Motion.state;
      st.vx = f[1]; st.wz = f[2]; st.height = f[3];
      if (Y.Natural.setBrake) Y.Natural.setBrake(!!f[4]);
      const i = S.i;
      S.take.events.forEach(function (e) {
        if (e[0] !== i) return;
        if (e[1] === "fig") Y.Stunt.start(e[2], e[3]);
        else if (e[1] === "release") Y.Stunt.release();
        else if (e[1] === "trick") Y.Natural.trick(e[2]);
      });
    },

    /** En enregistrement : garder l'image qu'on vient de jouer. */
    capture: function (dt) {
      if (S.mode === "play") { S.i += 1; return; }
      if (S.mode !== "rec") return;
      const st = Y.Motion.state;
      const i = S.take.frames.length;
      S.take.frames.push([rdt(dt), r3(st.vx), r3(st.wz),
                          r3(st.height), Y.Natural.braking() ? 1 : 0]);
      S.pending.forEach(function (e) { S.take.events.push([i].concat(e)); });
      S.pending = [];
      // Un changement de mode se lit sur l'état : on le note quand il bouge.
      if (st.mode !== S.lastMode) { S.take.events.push([i, "mode", st.mode]); S.lastMode = st.mode; }
    },

    /** Durée et taille de la prise, pour l'affichage. */
    info: function () {
      const t = S.take;
      if (!t || !t.frames.length) return null;
      let d = 0;
      t.frames.forEach(function (f) { d += f[0]; });
      return { seconds: d, frames: t.frames.length, events: t.events.length,
               terrain: t.terrain, date: t.date };
    },

    take: function () { return S.take; },
    toJSON: function () { return JSON.stringify(S.take); },

    /** Relire une prise venue d'un fichier. On vérifie ce qu'on reçoit. */
    fromJSON: function (text) {
      let t;
      try { t = JSON.parse(text); } catch (e) { return "fichier illisible"; }
      if (!t || t.format !== "ylo2-run") return "ce n'est pas une prise YLO-2";
      if (t.version > VERSION) return "prise trop récente pour cette page";
      if (!Array.isArray(t.frames) || !t.frames.length) return "prise vide";
      if (!t.start) return "prise sans état de départ";
      S.take = t; emit();
      return null;
    }
  };

  wrap();
})(window.YLO);
