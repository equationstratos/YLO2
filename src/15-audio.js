/* =====================================================================
   YLO-2 — le son, fabriqué et non joué

   Pas un seul fichier audio dans ce visualiseur : tout est SYNTHÉTISÉ à
   l'exécution. Un échantillon de coup de feu pèserait plus lourd que la
   moitié de la géométrie du robot, il sonnerait pareil à chaque fois, et
   il faudrait le charger avant de pouvoir tirer. Un bruit blanc filtré
   coûte quelques lignes, ne se répète jamais tout à fait, et suit la
   scène : la queue de réverbération du champ de tir est le renvoi des
   merlons, elle n'a de sens que là.

   Un coup de feu, ce n'est pas un « bang ». C'est trois choses qui se
   superposent dans les cent premières millisecondes :

     · la DÉTONATION — un souffle large, très bref, qui claque ;
     · le CORPS — une descente basse, le volume d'air de la culasse ;
     · la QUEUE — le même souffle, plus sourd, renvoyé par ce qu'il y a
       autour, une trentaine de millisecondes plus tard.

   Le navigateur n'autorise le son qu'après un geste de l'utilisateur.
   Le contexte est donc créé au premier coup et non au chargement : on ne
   demande rien tant que personne n'a rien demandé.
   ===================================================================== */
(function (Y) {
  "use strict";

  let ctx = null, master = null, noise = null;
  let on = true;

  /** Un tampon de bruit blanc, fabriqué une fois et relu à volonté. */
  function noiseBuffer() {
    if (noise) return noise;
    const n = Math.floor(ctx.sampleRate * 0.5);
    noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return noise;
  }

  /**
   * Ouvrir le son. Sans geste préalable de l'utilisateur, le contexte naît
   * suspendu — on le réveille à chaque appel, c'est sans effet s'il tourne
   * déjà, et cela évite d'avoir à deviner QUEL geste l'a débloqué.
   */
  function wake() {
    if (!on) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /** Une bouffée de bruit filtrée : la brique de tous les bruits secs. */
  function burst(o) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    src.playbackRate.value = o.rate || 1;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type || "bandpass";
    flt.frequency.setValueAtTime(o.f0, ctx.currentTime + (o.at || 0));
    if (o.f1) {
      flt.frequency.exponentialRampToValueAtTime(
        Math.max(40, o.f1), ctx.currentTime + (o.at || 0) + o.dur);
    }
    flt.Q.value = o.q || 0.9;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + (o.at || 0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.attack || 0.001));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + o.dur + 0.02);
  }

  /** Un ton simple : les bips, les clics de mécanique, les impacts. */
  function tone(o) {
    const osc = ctx.createOscillator();
    osc.type = o.type || "sine";
    const t0 = ctx.currentTime + (o.at || 0);
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + o.dur + 0.02);
  }

  Y.Audio = {
    /** Réveiller le son au premier geste : appelé par l'application. */
    wake: wake,
    /** Couper ou rendre le son. */
    set: function (v) {
      on = !!v;
      if (master) master.gain.value = on ? 0.55 : 0;
    },
    enabled: function () { return on; },

    /**
     * Le coup de feu.
     *
     * `k` fait varier le timbre d'un coup à l'autre — dans une rafale, trois
     * coups strictement identiques s'entendent comme un défaut de boucle et
     * non comme une arme automatique. Un pour cent de hasard sur les
     * fréquences suffit à faire disparaître l'effet.
     */
    shot: function () {
      if (!wake()) return;
      const k = 0.94 + Math.random() * 0.12;
      // détonation : large, très courte, c'est elle qui claque
      burst({ f0: 2600 * k, f1: 700, dur: 0.11, gain: 0.85, q: 0.5, rate: 1.1 });
      // corps : la descente basse, le volume de la culasse
      tone({ type: "triangle", f0: 190 * k, f1: 48, dur: 0.14, gain: 0.55 });
      // claquement de culasse, deux centièmes plus tard
      burst({ at: 0.022, f0: 5200, f1: 3400, dur: 0.035, gain: 0.16, q: 2.2 });
      // renvoi des merlons : le même souffle, sourd et en retard
      burst({ at: 0.055, f0: 700, f1: 240, dur: 0.30, gain: 0.13, q: 0.6, rate: 0.7 });
      burst({ at: 0.135, f0: 420, f1: 160, dur: 0.42, gain: 0.06, q: 0.5, rate: 0.5 });
    },

    /** Balle dans la cible : le claquement sec de la tôle. */
    hit: function () {
      if (!wake()) return;
      tone({ type: "square", f0: 1180, f1: 380, dur: 0.13, gain: 0.22 });
      burst({ f0: 3200, f1: 900, dur: 0.09, gain: 0.20, q: 1.6 });
      // la silhouette bascule : un choc mat sur son pivot
      tone({ at: 0.12, type: "sine", f0: 120, f1: 55, dur: 0.20, gain: 0.20 });
    },

    /** Balle à côté : elle part dans la butte, sans le claquement de tôle. */
    miss: function () {
      if (!wake()) return;
      burst({ at: 0.02, f0: 900, f1: 200, dur: 0.16, gain: 0.10, q: 0.8, rate: 0.6 });
    },

    /** Chargeur : on retire, on claque, on arme. */
    reload: function () {
      if (!wake()) return;
      tone({ type: "square", f0: 260, f1: 150, dur: 0.05, gain: 0.13 });
      tone({ at: 0.55, type: "square", f0: 320, f1: 190, dur: 0.05, gain: 0.15 });
      tone({ at: 1.30, type: "square", f0: 520, f1: 260, dur: 0.06, gain: 0.17 });
    },

    /** Verrouillage : le bip court qui accompagne le viseur qui rougit. */
    lock: function () {
      if (!wake()) return;
      tone({ type: "square", f0: 1560, dur: 0.055, gain: 0.10 });
    },

    /** Verrouillage FIGÉ à la main : deux tons montants, on tient la cible. */
    hold: function () {
      if (!wake()) return;
      tone({ type: "square", f0: 880, dur: 0.06, gain: 0.12 });
      tone({ at: 0.07, type: "square", f0: 1320, dur: 0.09, gain: 0.12 });
    },

    /** Cible déclarée amie : deux tons descendants, on baisse l'arme. */
    friend: function () {
      if (!wake()) return;
      tone({ type: "sine", f0: 990, dur: 0.09, gain: 0.16 });
      tone({ at: 0.09, type: "sine", f0: 620, dur: 0.16, gain: 0.16 });
    },

    /** Cible repérée : le pointillé court d'un écho radar. */
    ping: function () {
      if (!wake()) return;
      tone({ type: "sine", f0: 1750, dur: 0.05, gain: 0.07 });
      tone({ at: 0.05, type: "sine", f0: 2350, dur: 0.07, gain: 0.05 });
    },

    /** Les cibles se relèvent : le grincement des vérins. */
    raise: function () {
      if (!wake()) return;
      burst({ f0: 420, f1: 1200, dur: 0.36, gain: 0.09, q: 3.0, rate: 0.5 });
      tone({ at: 0.34, type: "square", f0: 700, dur: 0.07, gain: 0.10 });
    },

    /** Série terminée. */
    done: function () {
      if (!wake()) return;
      [660, 880, 1320].forEach(function (f, i) {
        tone({ at: i * 0.10, type: "square", f0: f, dur: 0.13, gain: 0.13 });
      });
    }
  };
})(window.YLO);
