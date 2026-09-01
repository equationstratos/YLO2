/* =====================================================================
   YLO-2 — le Shuffle

   Un pas de danse, et pas une figure de plus.

   Les figures du catalogue sont des acrobaties : elles quittent le sol, se
   retournent, et le moteur qui les joue écrit directement l'assiette et les
   appuis. Un pas de danse ne fait rien de tout cela — il MARCHE. C'est une
   suite de consignes de marche, jouée au tempo : quelques pas de côté, un
   pivot, une révérence. Le générateur d'allure existant fait le reste, et
   c'est lui qui donne au shuffle son balancement de hanches : le style
   « souple » fait déjà osciller la caisse au rythme du trot, il suffit de
   lui donner des pas qui vont d'un côté puis de l'autre.

   Écrire la danse dans le vocabulaire du robot plutôt que dans celui de
   l'animation a un avantage qu'on ne voit qu'à l'usage : elle reste vraie.
   Le robot ne triche pas, ses douze articulations font ce qu'elles feraient
   pour n'importe quel déplacement, les butées tiennent, et la danse marche
   sur un terrain en pente comme sur du plat.
   ===================================================================== */
(function (Y) {
  "use strict";

  /* Le tempo. 0,52 s la mesure, soit 115 à la noire — le tempo des
     démonstrations de danse de quadrupèdes, et surtout celui auquel un trot
     de robot tombe juste. */
  const BEAT = 0.52;

  /* La chorégraphie, en consignes de marche. Chaque temps donne une vitesse
     longitudinale, une vitesse latérale, une rotation, une hauteur de caisse
     et une garde au sol. Rien d'autre : ce sont exactement les commandes
     qu'un pilote peut donner, et c'est ce qui rend le pas reproductible. */
  const SHUFFLE = [
    { n: 1, vx: 0.00, vy: 0.00, wz: 0.0, h: 0.250, sw: 0.045, say: "En place" },

    // 1. le shuffle : quatre allers-retours latéraux, en avançant un peu
    { n: 1, vx: 0.18, vy: -0.62, wz: 0.55, h: 0.232, sw: 0.062, say: "Shuffle" },
    { n: 1, vx: 0.18, vy: 0.62, wz: -0.55, h: 0.268, sw: 0.062 },
    { n: 1, vx: 0.18, vy: -0.62, wz: 0.55, h: 0.232, sw: 0.062 },
    { n: 1, vx: 0.18, vy: 0.62, wz: -0.55, h: 0.268, sw: 0.062 },

    // 2. deux pas serrés, plus bas et plus vifs : le « in »
    { n: 0.5, vx: 0.40, vy: -0.40, wz: 0.0, h: 0.215, sw: 0.070, say: "Shuffle in" },
    { n: 0.5, vx: 0.40, vy: 0.40, wz: 0.0, h: 0.215, sw: 0.070 },
    { n: 0.5, vx: 0.40, vy: -0.40, wz: 0.0, h: 0.215, sw: 0.070 },
    { n: 0.5, vx: 0.40, vy: 0.40, wz: 0.0, h: 0.215, sw: 0.070 },

    /* 3. le pivot : un TOUR COMPLET sur place, caisse haute. Quatre temps et
          non deux — à deux, la commande demandait six radians par seconde,
          que l'accélération angulaire du robot n'atteint jamais : il faisait
          un demi-tour et l'on croyait le pas raté. */
    { n: 4, vx: 0.00, vy: 0.00, wz: 3.02, h: 0.285, sw: 0.050, say: "Pivot" },

    // 4. deux pas en arrière, hanches marquées
    { n: 1, vx: -0.30, vy: 0.55, wz: -0.70, h: 0.240, sw: 0.060, say: "Retour" },
    { n: 1, vx: -0.30, vy: -0.55, wz: 0.70, h: 0.240, sw: 0.060 },

    // 5. la révérence : on s'écrase, on remonte
    { n: 1, vx: 0.00, vy: 0.00, wz: 0.0, h: 0.170, sw: 0.030, say: "Révérence" },
    { n: 1, vx: 0.00, vy: 0.00, wz: 0.0, h: 0.290, sw: 0.045 },
    { n: 0.6, vx: 0.00, vy: 0.00, wz: 0.0, h: 0.250, sw: 0.045, say: "" }
  ];

  /* Le fondu d'un temps sur l'autre. Passer d'un pas de côté à l'autre en une
     image donnerait une consigne en créneau, que les pattes suivraient en
     saccade ; 160 ms de transition suffisent à lier les pas sans mollir le
     rythme. */
  const BLEND = 0.16;

  const S = { on: false, t: 0, i: 0, say: "", back: null, modeFn: null };

  function total() {
    let d = 0;
    SHUFFLE.forEach(function (s) { d += s.n * BEAT; });
    return d;
  }

  const DUR = total();

  function lerp(a, b, k) { return a + (b - a) * k; }

  /** Le pas courant, et le suivant, avec le fondu entre les deux. */
  function sample(t) {
    let acc = 0;
    for (let i = 0; i < SHUFFLE.length; i++) {
      const s = SHUFFLE[i], d = s.n * BEAT;
      if (t < acc + d || i === SHUFFLE.length - 1) {
        const nx = SHUFFLE[Math.min(i + 1, SHUFFLE.length - 1)];
        const into = t - acc;
        const k = into < BLEND && i > 0
          ? 0                                   // le fondu se fait à la SORTIE
          : Math.max(0, (into - (d - BLEND)) / BLEND);
        return {
          i: i,
          vx: lerp(s.vx, nx.vx, k), vy: lerp(s.vy, nx.vy, k),
          wz: lerp(s.wz, nx.wz, k), h: lerp(s.h, nx.h, k),
          sw: lerp(s.sw, nx.sw, k), say: s.say
        };
      }
      acc += d;
    }
    return null;
  }

  Y.Dance = {
    state: S,
    duration: DUR,

    /**
     * Lancer le pas. `modeFn` sert à passer sur les PATTES et à revenir comme
     * on était : un shuffle sur roues n'aurait pas de pas.
     */
    start: function (modeFn) {
      if (S.on) return false;
      const st = Y.Motion.state;
      S.modeFn = modeFn || null;
      S.back = { mode: st.mode, gait: st.gait, height: st.height,
                 swing: st.swing, vx: st.vx, vy: st.vy, wz: st.wz };
      if (Y.Stunt) Y.Stunt.stop(false);
      if (Y.Natural) { Y.Natural.setFreeRoll(false); Y.Natural.setBrake(false); }
      if (S.modeFn) S.modeFn("pattes"); else st.mode = "pattes";
      st.gait = "trot";
      S.on = true; S.t = 0; S.say = "Shuffle";
      return true;
    },

    stop: function () {
      if (!S.on) return;
      const st = Y.Motion.state, b = S.back;
      S.on = false; S.say = "";
      if (!b) return;
      st.vx = 0; st.vy = 0; st.wz = 0;
      /* Le mode d'abord, la posture ensuite : revenir aux roues impose sa
         propre hauteur de caisse, et la rendre avant la remettrait à zéro. */
      if (b.mode !== "pattes") { if (S.modeFn) S.modeFn(b.mode); else st.mode = b.mode; }
      st.gait = b.gait; st.height = b.height; st.swing = b.swing;
      S.back = null;
    },

    dancing: function () { return S.on; },

    /** Appelé AVANT le pas de simulation : la danse donne les consignes. */
    step: function (dt) {
      if (!S.on) return false;
      S.t += dt;
      if (S.t >= DUR) { Y.Dance.stop(); return false; }
      const c = sample(S.t);
      if (!c) { Y.Dance.stop(); return false; }
      const st = Y.Motion.state;
      st.vx = c.vx; st.vy = c.vy; st.wz = c.wz;
      st.height = c.h; st.swing = c.sw;
      if (c.say) S.say = c.say;
      S.i = c.i;
      return true;
    }
  };
})(window.YLO);
