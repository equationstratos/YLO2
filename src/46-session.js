/* =====================================================================
   YLO-2 — session de skatepark

   Un enchaînement chronométré : le robot parcourt la plaza en roues et
   place ses figures là où le relief les appelle, comme un run de skate.
   Le script est une liste d'actes ; chacun sait quand il est fini, et
   c'est ce qui donne le rythme — on n'attend pas un chrono fixe, on
   attend d'être arrivé.

   Trois sortes d'actes :

     roll   { to, v }        rouler jusqu'à l'abscisse `to`, dans le monde
     brake  { }              s'arrêter net avant une figure qui se pose
     fig    { id, hold }     déclencher une figure ; `hold` donne sa durée
                             de tenue quand elle se maintient
     pause  { hold }         tenir la position quelques dixièmes

   Les figures qui décollent sont placées AVANT le module, pour que le vol
   passe au-dessus ; les tenues sont placées sur du plat, sans quoi elles
   sont refusées (la bascule veut une ligne de contact horizontale).
   ===================================================================== */
(function (Y) {
  "use strict";

  /**
   * Le run, calé sur les cotes du terrain `skatepark` :
   * kicker 1,40 → 2,10 · funbox 3,60 → 6,00 · quarter à 7,80 et −2,60.
   */
  const RUN = [
    // Une figure décolle 0,76 s après le déclenchement (armement + poussée) :
    // à 1,4 m/s d'élan, ça fait 0,76 m. Les déclenchements sont donc placés
    // trois quarts de mètre avant la lèvre visée, pour que la POUSSÉE tombe
    // dessus et que ce soit la rampe qui lance le robot — comme en skate.
    //
    // Lèvres du parc : kicker 2,10 · funbox 4,30 · descente du funbox 5,30
    // (une lèvre quand on la remonte en sens inverse) · kicker 2,10 encore
    // au retour. Une figure court ensuite 2,6 à 3,2 m : c'est de l'ordre de
    // l'écart entre deux modules, et c'est ce qui limite la ligne à six
    // figures — comme une vraie ligne de skate.
    { act: "roll", to: 0.40, v: 1.4, say: "mise en route" },
    { act: "brake", say: "pose avant le cabrage" },
    { act: "fig", id: "wheelie", hold: 1.1, say: "cabrage d'entrée" },

    { act: "roll", to: 1.34, v: 1.4, say: "élan vers le kicker" },
    { act: "fig", id: "wheeljump", say: "saut lancé par le kicker" },

    { act: "roll", to: 3.95, v: 1.4, say: "élan vers le funbox" },
    { act: "fig", id: "wheelfrontflip", say: "salto avant lancé par le funbox" },

    { act: "roll", to: 6.90, v: 1.8, say: "relance vers le quarter" },
    { act: "brake", say: "pose au pied du quarter" },
    { act: "fig", id: "pirouette", say: "pirouette — demi-tour" },

    { act: "roll", to: 5.72, v: 1.4, say: "élan vers la descente du funbox" },
    { act: "fig", id: "wheelsideflipR", say: "salto latéral lancé par le funbox" },

    { act: "roll", to: 2.72, v: 1.4, say: "élan vers le kicker, à l'envers" },
    { act: "fig", id: "wheeltwist540", say: "540 McTwist lancé par le kicker — fakie" },

    { act: "roll", to: -0.40, v: 2.2, say: "lancement du slide" },
    { act: "fig", id: "powerslide", say: "slide final" },
    { act: "pause", hold: 1.4, say: "fin de session" }
  ];

  /**
   * Cadrages : la caméra suit le robot de loin sur les liaisons et se
   * rapproche sur les figures, comme un caméraman de session.
   */
  const SHOTS = {
    roll:   { dist: 3.6, el: 0.22, az: -1.05, lead: 0.55 },
    fig:    { dist: 2.5, el: 0.13, az: -1.45, lead: 0.10 },
    tilt:   { dist: 2.2, el: 0.06, az: -1.30, lead: 0.00 },
    slide:  { dist: 3.2, el: 0.30, az: -2.10, lead: 0.00 },
    pause:  { dist: 4.2, el: 0.34, az: -0.80, lead: 0.00 }
  };

  const S = {
    running: false, i: 0, t: 0, waited: 0, started: false,
    label: "", listeners: []
  };

  function emit() { S.listeners.forEach(function (fn) { fn(S); }); }

  function shotFor(step) {
    if (!step) return SHOTS.pause;
    if (step.act === "brake") return SHOTS.tilt;
    if (step.act !== "fig") return SHOTS[step.act] || SHOTS.roll;
    const f = Y.Stunt.figures[step.id];
    if (f && f.kind === "tilt") return SHOTS.tilt;
    if (f && f.kind === "slide") return SHOTS.slide;
    return SHOTS.fig;
  }

  function advance() {
    S.i += 1; S.t = 0; S.waited = 0; S.started = false;
    if (S.i >= RUN.length) { Y.Session.stop(); return; }
    S.label = RUN[S.i].say || "";
    emit();
  }

  Y.Session = {
    run: RUN,
    state: S,
    shots: SHOTS,
    onChange: function (fn) { S.listeners.push(fn); },

    /** Cadrage voulu par l'acte en cours, pour la caméra de l'application. */
    shot: function () { return shotFor(RUN[S.i]); },

    start: function () {
      if (Y.Motion.state.mode !== "roues") return false;
      S.running = true; S.i = -1;
      advance();
      return true;
    },

    stop: function () {
      if (!S.running) return;
      S.running = false; S.label = "";
      Y.Motion.state.vx = 0; Y.Motion.state.wz = 0;
      emit();
    },

    /**
     * Un pas de session. Rend `true` si elle pilote encore le robot.
     *
     * On ne pilote que la consigne : la couche roues garde la main sur les
     * accélérations, la suspension et le franchissement. Une session ne
     * triche pas sur la dynamique, elle appuie sur les mêmes boutons.
     */
    step: function (dt) {
      if (!S.running) return false;
      const st = Y.Motion.state;
      if (st.mode !== "roues") { this.stop(); return false; }
      const step = RUN[S.i];
      if (!step) { this.stop(); return false; }
      S.t += dt;

      if (step.act === "roll") {
        // On vise une abscisse dans le MONDE, et on en déduit le signe de la
        // consigne. La vitesse monde vaut `vx · direction · cos(cap)` : après
        // une pirouette le nez a fait demi-tour, après un 540 le sens de
        // marche est inversé, et cette seule ligne encaisse les deux sans
        // que le script ait à tenir les comptes.
        const gap = step.to - st.px;
        const heading = Math.cos(st.yaw) >= 0 ? 1 : -1;
        const need = gap >= 0 ? 1 : -1;
        st.vx = Math.abs(gap) > 0.06
          ? Math.abs(step.v) * need * heading * (Y.Natural.state.dir || 1) : 0;
        st.wz = 0;
        if (Math.abs(gap) <= 0.06 || S.t > 12) advance();
        return true;
      }

      if (step.act === "brake") {
        // Une tenue et une pirouette se posent à l'arrêt : sans ce temps
        // mort, la figure emportait le robot de plusieurs mètres et le run
        // se décalait de module en module.
        st.vx = 0; st.wz = 0;
        if (Math.abs(Y.Natural.state.vx) < 0.06 || S.t > 4) advance();
        return true;
      }

      if (step.act === "pause") {
        st.vx = 0; st.wz = 0;
        if (S.t >= (step.hold || 1)) advance();
        return true;
      }

      // acte « figure »
      if (!S.started) {
        const ok = Y.Stunt.start(step.id);
        if (ok === "pente") {                     // sol trop irrégulier ici
          S.label = Y.Stunt.label(step.id) + " : sol non plat, sautée";
          emit();
          advance();
          return true;
        }
        if (!ok) { advance(); return true; }
        S.started = true;
        // une tenue ne se relâche pas toute seule : on lui donne sa durée
        S.waited = step.hold || 0;
        emit();
      }
      if (Y.Stunt.sustaining()) {
        S.waited -= dt;
        if (S.waited <= 0) Y.Stunt.release();
      }
      if (!Y.Stunt.active) advance();
      st.wz = 0;
      return true;
    }
  };
})(window.YLO);
