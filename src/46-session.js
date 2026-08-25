/* =====================================================================
   YLO-2 — session de skatepark

   Un enchaînement chronométré : le robot parcourt la plaza en roues et
   place ses figures là où le relief les appelle, comme un run de skate.
   Le script est une liste d'actes ; chacun sait quand il est fini, et
   c'est ce qui donne le rythme — on n'attend pas un chrono fixe, on
   attend d'être arrivé.

   Trois sortes d'actes :

     place  { x, y, yaw }    poser le robot là, d'aplomb sur le relief
     roll   { to, v }        rouler jusqu'à l'abscisse `to`, dans le monde
     goto   { x, y, v }      rejoindre un point en braquant : sert à changer
                             de voie, pour longer le ledge par exemple
     face   { yaw }          pivoter sur place jusqu'au cap voulu
     brake  { }              s'arrêter net avant une figure qui se pose
     fig    { id, hold, v }  déclencher une figure ; `hold` donne sa durée de
                             tenue quand elle se maintient, `v` la vitesse à
                             tenir pendant — c'est ainsi qu'on roule sur deux
                             roues le long d'un obstacle
     pause  { hold }         tenir la position quelques dixièmes

   Les figures qui décollent sont placées AVANT le module, pour que le vol
   passe au-dessus ; les tenues sont placées sur du plat, sans quoi elles
   sont refusées (la bascule veut une ligne de contact horizontale).
   ===================================================================== */
(function (Y) {
  "use strict";

  const clamp = function (v, a, b) { return Math.min(Math.max(v, a), b); };

  /**
   * Le run, calé sur les cotes du terrain `skatepark` :
   * kicker 1,40 → 2,10 · funbox 3,60 → 6,00 · quarter à 7,80 et −2,60.
   */
  const RUN = [
    // Le run part du point le plus haut du parc — la plateforme du quarter
    // arrière, à 450 mm — descend la transition et enchaîne jusqu'au quarter
    // avant. Les figures aériennes sont déclenchées 0,76 m avant la lèvre
    // visée, pour que la POUSSÉE tombe dessus : c'est la rampe qui lance.
    //
    // Cotes : quarter arrière -2,60 (transition) / -3,05 à -3,95 (plateforme)
    // · kicker 1,40 → 2,10 · funbox 3,60 → 6,00 · ledge y 1,70 → 2,10, x 3,40
    // → 6,20 · quarter avant 7,80 (transition) / 8,25 à 9,15 (plateforme).
    { act: "place", x: -3.50, y: 0, yaw: 0, say: "en haut du quarter arrière" },
    { act: "roll", to: -2.95, v: 1.0, say: "drop-in dans la transition" },
    { act: "fig", id: "wheelfrontflip", say: "salto avant lancé par la transition" },

    { act: "roll", to: 1.34, v: 1.4, say: "élan vers le kicker" },
    { act: "fig", id: "wheeljump", say: "saut lancé par le kicker" },

    // on se range le long du ledge et on le remonte sur deux roues, sur toute
    // sa longueur — dans le sens de la marche, un demi-tour mordrait dessus
    { act: "goto", x: 2.90, y: 1.35, v: 1.2, say: "on se range le long du ledge" },
    { act: "face", yaw: 0, say: "dans l'axe du ledge" },
    { act: "brake", say: "mise en appui" },
    { act: "fig", id: "sidestand", hold: 2.2, v: 0.9,
      say: "sur deux roues, tout le long du ledge" },

    { act: "goto", x: 7.05, y: 0.0, v: 1.2, say: "retour dans l'axe" },
    { act: "face", yaw: 0, say: "face au quarter avant" },
    { act: "roll", to: 7.25, v: 0.9, say: "élan mesuré vers la lèvre" },
    { act: "fig", id: "wheeltwist540", say: "540 McTwist lancé par la lèvre" },

    { act: "roll", to: 3.40, v: 2.0, say: "retour fakie" },
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
    if (step.act === "brake" || step.act === "place" || step.act === "face") return SHOTS.tilt;
    if (step.act === "goto") return SHOTS.roll;
    if (step.act !== "fig") return SHOTS[step.act] || SHOTS.roll;
    const f = Y.Stunt.figures[step.id];
    if (f && f.kind === "tilt") return SHOTS.tilt;
    if (f && f.kind === "slide") return SHOTS.slide;
    return SHOTS.fig;
  }

  function advance() {
    S.i += 1; S.t = 0; S.waited = 0; S.started = false; S.side = 0;
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
        if (!S.side) S.side = gap >= 0 ? 1 : -1;
        // On s'arrête quand on a DÉPASSÉ la cible, pas quand on est dans une
        // fenêtre de 60 mm : à 2 m/s le navigateur avance de 130 mm par image
        // quand le rendu tombe à 15 images/s, et la fenêtre était enjambée —
        // l'acte partait alors en va-et-vient jusqu'à sa garde de 12 s, et le
        // slide final se déclenchait un mètre et demi trop loin, sur la rampe
        // du kicker.
        const done = gap * S.side <= 0.06;
        const heading = Math.cos(st.yaw) >= 0 ? 1 : -1;
        st.vx = done ? 0
          : Math.abs(step.v) * S.side * heading * (Y.Natural.state.dir || 1);
        st.wz = 0;
        if (done || S.t > 12) advance();
        return true;
      }

      if (step.act === "place") {
        // Poser le robot d'aplomb sur le relief : c'est ce qui permet de
        // commencer le run en haut de la plateforme du quarter, la rampe la
        // plus haute du parc.
        st.px = step.x; st.py = step.y || 0; st.yaw = step.yaw || 0;
        st.roll = 0; st.pitch = 0; st.vx = 0; st.wz = 0;
        st.z = Y.Terrain.heightAt(st.px, st.py) + st.height * 0.92 + Y.Natural.wheelRadius;
        Y.Natural.reset();
        Y.Motion.blendFrom(0.3);
        advance();
        return true;
      }

      if (step.act === "goto") {
        // Rejoindre un point en braquant. Le cap voulu se mesure dans le
        // monde ; en fakie le robot avance à l'envers, donc la cible est
        // derrière lui et le braquage s'inverse.
        const dir = Y.Natural.state.dir || 1;
        const dx = step.x - st.px, dy = (step.y || 0) - st.py;
        const dist = Math.hypot(dx, dy);
        if (dist <= 0.10 || S.t > 14) { st.vx = 0; st.wz = 0; advance(); return true; }
        let err = Math.atan2(dy, dx) - st.yaw;
        if (dir < 0) err += Math.PI;
        err = ((err + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.wz = clamp(err * 2.2, -1.4, 1.4);
        // on ralentit tant qu'on n'est pas dans l'axe : braquer à pleine
        // vitesse ferait déraper le robot au lieu de le placer
        st.vx = Math.abs(step.v) * dir * Math.max(0.25, Math.cos(err));
        return true;
      }

      if (step.act === "face") {
        // Un `goto` arrive au point mais pas dans l'axe : il finit en visant
        // sa cible. Sans ce recalage, « avancer » le long du ledge partait de
        // travers, voire à reculons quand le cap avait dépassé 90°.
        const want = step.yaw || 0;
        let err = ((want - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.vx = 0;
        st.wz = clamp(err * 2.0, -1.0, 1.0);
        if (Math.abs(err) < 0.03 || S.t > 6) { st.wz = 0; advance(); }
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
      // Une tenue peut se faire en roulant : c'est ainsi qu'on longe un
      // obstacle sur deux roues, sur toute sa longueur. On écrit la vitesse
      // RÉELLE, pas la consigne : pendant une figure c'est le pilote de
      // figure qui a la main, la couche roues ne tourne pas et ne convertirait
      // donc jamais la consigne en mouvement.
      if (step.v !== undefined) {
        st.vx = step.v * (Y.Natural.state.dir || 1);
        Y.Natural.state.vx = step.v * (Y.Natural.state.dir || 1);
      }
      st.wz = 0;
      if (!Y.Stunt.active) advance();
      return true;
    }
  };
})(window.YLO);
