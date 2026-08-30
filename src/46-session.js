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
     carve  { to, y, v }     y aller en SERPENTANT, comme un skateur qui pompe
                             ses appuis : c'est ce qui donne le liant entre
                             deux modules, et c'est là qu'on prend la vitesse
     goto   { x, y, v }      rejoindre un point en braquant : sert à changer
                             de voie, pour longer le ledge par exemple
     face   { yaw }          pivoter sur place jusqu'au cap voulu
     brake  { }              s'arrêter net avant une figure qui se pose
     fig    { id, hold, v }  déclencher une figure ; `hold` donne sa durée de
                             tenue quand elle se maintient, `v` la vitesse à
                             tenir pendant — c'est ainsi qu'on roule sur deux
                             roues le long d'un obstacle
     air    { ids, lip, v }  charger la lèvre en roue libre et lâcher une ou
                             plusieurs figures DANS le vol, puis attendre le
                             verdict de la réception
     free   { on }           roue libre : la physique de skate, gravité et
                             pompage compris
     mode   { to }           passer sur pattes ou sur roues : quatre figures
                             du catalogue ne se font que jambes au sol
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
    // Chaque figure du catalogue est jouée UNE SEULE FOIS, et chaque module
    // a les siennes : le kicker, la table, le ledge, les deux quarters, le
    // plat. On ne répète pas un cabrage à deux endroits — un run de skate ne
    // refait pas le même trick, il en place un par obstacle.
    //
    // Cotes : quarter arrière -2,60 (transition) / -3,95 à -3,05 (plateforme)
    // · kicker 1,40 → 2,10 · funbox 3,60 → 6,00 (plateau 4,30 → 5,30 à
    // 180 mm) · ledge y 1,70 → 2,10, x 3,40 → 6,20, 200 mm · quarter avant
    // 7,80 (transition) / 8,25 à 9,15 (plateforme).

    /* ---------------- le quarter arrière : le départ ---------------- */
    { act: "place", x: -3.80, y: 0, yaw: 0, say: "en haut du quarter arrière" },
    { act: "roll", to: -3.15, y: 0, v: 0.9, say: "on roule sur le plat de la plateforme" },
    { act: "roll", to: -2.95, v: 1.1, say: "drop-in dans la transition" },
    { act: "fig", id: "wheelfrontflip", say: "salto avant lancé par la transition" },

    /* ---------------- le kicker ---------------- */
    { act: "carve", to: 1.30, y: 0, v: 3.2, amp: 0.38, wave: 1.7,
      say: "carve plein gaz vers le kicker" },
    { act: "fig", id: "wheelflip", say: "salto roues lancé par le kicker" },

    /* ---------------- la table du milieu ---------------- */
    { act: "carve", to: 3.05, y: 0, v: 2.3, amp: 0.28, wave: 1.4,
      say: "on se présente sur la table" },
    { act: "fig", id: "wheeldoubleflip", say: "double salto lancé par la table" },
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "roll", to: 4.65, y: 0, v: 1.3, say: "on roule sur le plat de la table" },
    { act: "fig", id: "wheelie", hold: 1.5, v: 0.9, say: "cabrage roulé sur la table" },
    { act: "fig", id: "powerslide", say: "slide sur la table" },

    /* ---------------- le ledge : l'équilibre SUR l'obstacle ---------------- */
    // Le ledge fait 400 mm de large, la voie du robot 308 : il tient dessus.
    // On le monte par le bout, on le remonte en roulant, et c'est LÀ qu'on
    // bascule sur deux roues — les deux du bas posées sur le béton du ledge,
    // les deux du haut en l'air.
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "roll", to: 3.00, v: 2.0, say: "retour au bout du ledge" },
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "goto", x: 2.95, y: 1.90, v: 1.6, say: "on se présente au bout du ledge" },
    { act: "face", yaw: 0, say: "dans l'axe du ledge" },
    { act: "roll", to: 4.20, y: 1.90, v: 1.0, say: "50-50 : les quatre roues SUR le ledge" },
    { act: "brake", say: "mise en appui sur le ledge" },
    { act: "fig", id: "sidestand", hold: 2.6, v: 0.55,
      say: "équilibre SUR le ledge : deux roues dessus, deux en l'air" },
    { act: "roll", to: 6.70, y: 1.90, v: 1.2, say: "sortie de ledge" },
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "goto", x: 6.60, y: 1.35, v: 1.6, say: "on redescend d'une voie" },
    { act: "brake" },
    { act: "fig", id: "pirouette", hold: 1.5, say: "pirouette au pied du ledge" },

    /* ---------------- le quarter avant : les figures en l'air ---------------- */
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "goto", x: 6.30, y: 0, v: 2.2, say: "retour dans l'axe du quarter" },
    { act: "face", yaw: 0 },
    { act: "air", ids: ["back"], v: 1.7, say: "salto arrière au-dessus de la lèvre" },
    { act: "roll", to: 6.30, v: 2.2, say: "on reprend de l'élan" },
    { act: "air", ids: ["front"], v: 1.5, say: "salto avant au-dessus de la lèvre" },
    { act: "roll", to: 6.30, v: 2.2, say: "on reprend de l'élan" },
    { act: "air", ids: ["sideL"], v: 1.7, say: "salto latéral gauche en l'air" },
    { act: "roll", to: 6.30, v: 2.2, say: "on reprend de l'élan" },
    { act: "air", ids: ["sideR"], v: 1.7, say: "salto latéral droit en l'air" },
    { act: "roll", to: 6.30, v: 2.2, say: "on reprend de l'élan" },
    { act: "air", ids: ["spin360"], v: 2.1, say: "360 en l'air" },
    { act: "roll", to: 6.30, v: 2.2, say: "on reprend de l'élan" },
    // Le passage d'enchaînement tente deux figures dans le même vol. Les
    // 450 mm du quarter n'en donnent qu'une : mesuré, le vol vaut 0,65 s et
    // la seconde est refusée faute de hauteur au moment où la première se
    // boucle. Le mécanisme est celui du combo de la mega ramp, où il en
    // passe bien deux — c'est la rampe qui décide.
    { act: "air", ids: ["spin360", "back"], v: 2.1,
      say: "360, et salto arrière si la hauteur suit" },

    // Puis les figures lourdes, avec leur propre poussée sur la lèvre.
    { act: "roll", to: 7.05, v: 2.2, say: "retour vers la lèvre" },
    { act: "face", yaw: 0 },
    { act: "roll", to: 7.25, v: 0.9, say: "élan mesuré vers la lèvre" },
    { act: "fig", id: "wheeldoublefrontflip", say: "double salto avant sur la lèvre" },
    { act: "goto", x: 7.05, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    { act: "fig", id: "wheelsideflipL", say: "salto latéral gauche roues" },
    { act: "goto", x: 7.05, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    { act: "fig", id: "wheelsideflipR", say: "salto latéral droit roues" },
    { act: "goto", x: 7.05, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    { act: "fig", id: "wheeldoublesideflipL", say: "double latéral gauche" },
    { act: "goto", x: 7.05, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    { act: "fig", id: "wheeldoublesideflipR", say: "double latéral droit" },
    { act: "goto", x: 7.05, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    { act: "roll", to: 7.25, v: 0.9, say: "dernier élan vers la lèvre" },
    { act: "fig", id: "wheeltwist540", say: "540 McTwist lancé par la lèvre" },

    /* ---------------- le plat du quarter, et le saut de sortie ---------------- */
    // On monte la transition, on roule sur le PLAT de la plateforme, et on
    // repart par un saut : la réception tombe au-delà du nez, en dehors de
    // la rampe, sur le sol plat.
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "goto", x: 7.10, y: 0, v: 2.0 },
    { act: "face", yaw: 0 },
    /* Un seul `roll` du pied de la transition jusqu'au nez de la plateforme :
       le robot monte, roule sur le plat, et arrive au bord AVEC de la
       vitesse. En deux actes il arrivait au nez à l'arrêt, et le saut, qui
       emporte la vitesse du moment, retombait dans la rampe. */
    { act: "roll", to: 8.92, y: 0, v: 1.8,
      say: "on monte et on roule sur le plat de la plateforme" },
    { act: "fig", id: "wheeljump", v: 1.8,
      say: "saut de sortie : la réception tombe hors de la rampe" },

    /* ---------------- le plat central : la fin du catalogue ---------------- */
    { act: "brake" },
    { act: "face", yaw: 0 },
    { act: "goto", x: 0.20, y: 0, v: 2.4, say: "retour au centre de la plaza" },
    { act: "brake" },
    { act: "fig", id: "wheeltumble", say: "salto arrière enchaîné, roues 2 par 2" },
    { act: "brake" },
    { act: "mode", to: "pattes", say: "on repasse sur pattes" },
    { act: "pause", hold: 0.7 },
    { act: "fig", id: "backflip", say: "salto arrière sur pattes" },
    { act: "fig", id: "frontflip", say: "salto avant sur pattes" },
    { act: "fig", id: "doubleflip", say: "double salto sur pattes" },
    { act: "fig", id: "mctwist540", say: "540 McTwist sur pattes" },
    { act: "pause", hold: 0.5 },
    { act: "mode", to: "roues", say: "et on repart sur roues" },
    { act: "pause", hold: 0.6, say: "fin de session" }
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
    label: "", listeners: [],
    mode: "roues",    // mode attendu : si l'utilisateur en change, on arrête
    vmax: 0,          // vitesse la plus haute atteinte pendant la session
    fired: 0,         // figures déjà lâchées dans le vol en cours
    verdict: null,    // dernière réception jugée
    tricks: 0, clean: 0
  };

  function emit() { S.listeners.forEach(function (fn) { fn(S); }); }

  function shotFor(step) {
    if (!step) return SHOTS.pause;
    if (step.act === "brake" || step.act === "place" || step.act === "face") return SHOTS.tilt;
    if (step.act === "goto" || step.act === "carve") return SHOTS.roll;
    if (step.act === "air") return SHOTS.fig;
    if (step.act === "free") return SHOTS.roll;
    if (step.act !== "fig") return SHOTS[step.act] || SHOTS.roll;
    const f = Y.Stunt.figures[step.id];
    if (f && f.kind === "tilt") return SHOTS.tilt;
    if (f && f.kind === "slide") return SHOTS.slide;
    return SHOTS.fig;
  }

  function advance() {
    S.i += 1; S.t = 0; S.waited = 0; S.started = false; S.side = 0;
    S.fired = 0; S.verdict = null; S.settle = 0;
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
      S.mode = "roues";
      S.vmax = 0; S.tricks = 0; S.clean = 0;
      advance();
      return true;
    },

    stop: function () {
      if (!S.running) return;
      S.running = false; S.label = "";
      Y.Motion.state.vx = 0; Y.Motion.state.wz = 0;
      if (Y.Natural.setFreeRoll) Y.Natural.setFreeRoll(false);
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
      /* On compare au mode ATTENDU et non à « roues » : le run passe
         lui-même sur pattes le temps des quatre figures qui ne se font pas
         autrement. Si c'est l'utilisateur qui change de mode, l'attente ne
         correspond plus et la session s'arrête, comme avant. */
      if (st.mode !== S.mode) { this.stop(); return false; }
      const step = RUN[S.i];
      if (!step) { this.stop(); return false; }
      S.t += dt;
      // La vitesse maximale atteinte est une donnée du run, au même titre que
      // les figures posées : c'est elle qui dit si le parc a été pris vite.
      S.vmax = Math.max(S.vmax, Math.abs(Y.Natural.state.vx));

      if (step.act === "mode") {
        st.mode = S.mode = step.to;
        st.vx = 0; st.wz = 0;
        Y.Natural.reset();
        Y.Motion.blendFrom(0.3);
        advance();
        return true;
      }

      if (step.act === "free") {
        if (Y.Natural.setFreeRoll) Y.Natural.setFreeRoll(!!step.on);
        advance();
        return true;
      }

      if (step.act === "carve") {
        /* Serpenter, et non aller droit. Un skateur qui traverse un parc
           pompe ses appuis d'un bord à l'autre ; en ligne droite le robot
           avait l'air d'un chariot. L'amplitude se referme à l'approche de
           la cible pour finir dans l'axe, et un rappel vers la ligne
           empêche la serpentine de dériver — on louvoie AUTOUR d'un cap, on
           ne s'en va pas avec. */
        const gap = step.to - st.px;
        if (!S.side) S.side = gap >= 0 ? 1 : -1;
        const done = gap * S.side <= 0.06;
        const heading = Math.cos(st.yaw) >= 0 ? 1 : -1;
        const dir = Y.Natural.state.dir || 1;
        st.vx = done ? 0 : Math.abs(step.v) * S.side * heading * dir;
        const near = clamp(Math.abs(gap) / 1.4, 0, 1);
        const wave = (step.amp === undefined ? 0.35 : step.amp)
          * Math.sin(S.t * Math.PI * 2 / (step.wave || 1.6)) * near;
        /* Le rappel vers la ligne pèse plus lourd que la serpentine, sinon
           elle n'est plus un louvoiement mais un départ : à 0,85 rad
           d'amplitude le robot finissait deux mètres à côté du module qu'il
           visait. On carve AUTOUR d'une ligne. */
        const yErr = ((step.y || 0) - st.py) * S.side;
        const axis = S.side > 0 ? 0 : Math.PI;
        const want = axis + clamp(yErr * 1.5, -0.7, 0.7) + wave;
        let err = ((want - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.wz = done ? 0 : clamp(err * 2.0, -1.7, 1.7);
        if (done || S.t > 16) advance();
        return true;
      }

      if (step.act === "air") {
        /* Charger la lèvre, et lâcher la figure DANS le vol. C'est le geste
           du skate : on quitte le béton d'abord, on choisit ensuite, et on
           enchaîne tant qu'il reste du vol. La réception est jugée par la
           couche roues, pas par le script — le run affiche le verdict qu'il
           reçoit, propre ou non. */
        const dir = Y.Natural.state.dir || 1;
        const heading = Math.cos(st.yaw) >= 0 ? 1 : -1;
        if (!S.started) { S.started = true; Y.Natural.setFreeRoll(true); }
        st.wz = 0;
        /* On vise la lèvre dans le MONDE et on en déduit le signe, comme un
           `roll` : après un 360 le robot repart en fakie, et sans ce signe il
           chargeait la lèvre à l'envers. Passé la lèvre on coupe les gaz —
           sinon il franchit le deck et s'en va rouler à vingt mètres du parc,
           et la liaison suivante passe dix secondes à le ramener. */
        const lip = step.lip === undefined ? 8.15 : step.lip;
        const gap = lip - st.px;
        if (!S.side) S.side = gap >= 0 ? 1 : -1;
        st.vx = (gap * S.side <= 0 || S.verdict) ? 0
          : Math.abs(step.v || 3.0) * S.side * heading * dir;
        const ids = step.ids || [step.id];
        if (Y.Natural.wheelAirborne() && !Y.Natural.tricking() && S.fired < ids.length) {
          if (Y.Natural.trick(ids[S.fired])) S.fired++;
        }
        const got = Y.Natural.takeLanding();
        if (got) {
          S.tricks++; if (got.ok) S.clean++;
          S.verdict = got;
          /* On ne rend la main à la physique de roulage qu'une fois TOUTES
             les figures du passage lâchées. En coupant la roue libre dès la
             première, on interrompait le vol au milieu d'un enchaînement :
             le 360 qui devait suivre le salto n'avait plus d'air où se
             faire. */
          if (S.fired >= ids.length) {
            Y.Natural.setFreeRoll(false);
            Y.Natural.state.vx *= 0.35;
          }
          S.label = (step.say || got.label) + " — "
            + (got.ok ? "posé 10/10" : "réception manquée") + " · " + got.label;
          emit();
        }
        /* Trois secondes suffisent pour monter la transition : au-delà, le
           passage est manqué et on coupe les gaz plutôt que de le laisser
           partir. C'est la transition qui LANCE, pas la vitesse — mesuré, le
           vol vaut 0,65 à 0,73 s de 1,5 à 4 m/s, et au-delà de 2 m/s le robot
           franchit le deck : il quitte alors un bord PLAT, ce qui ne lance
           rien, et la figure est refusée faute de hauteur. */
        if (S.t > 3.2 && !S.verdict) st.vx = 0;
        if (S.verdict) S.settle += dt;
        /* La roue libre ne dure que le temps du passage. Tenue sur tout le
           run, elle rendait le robot ingouvernable entre deux modules : la
           gravité l'emmenait, une liaison mettait quatorze secondes à le
           replacer et il finissait à vingt mètres du parc. C'est une physique
           de saut, pas une physique de déplacement. */
        if ((S.verdict && S.settle > 0.55 && S.fired >= ids.length) || S.t > 6) {
          Y.Natural.setFreeRoll(false);
          advance();
        }
        return true;
      }

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
        /* Un `roll` peut tenir une LIGNE et pas seulement une abscisse. Sans
           ça, le robot arrivait sur le plateau de la table à y = 0,98 pour un
           module qui finit à 0,95, et sur le ledge à y = 1,95 pour un ledge
           qui finit à 2,10 : une roue dehors, sol non plat sous les roues, et
           la tenue sur deux roues était refusée. Une figure d'équilibre veut
           ses appuis sur le béton, pas à moitié dans le vide. */
        if (step.y === undefined || done) { st.wz = 0; }
        else {
          const yErr = ((step.y || 0) - st.py) * S.side;
          const axis = S.side > 0 ? 0 : Math.PI;
          const want = axis + clamp(yErr * 1.6, -0.5, 0.5);
          const e = ((want - st.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          st.wz = clamp(e * 2.0, -1.2, 1.2);
        }
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
        if (dist <= 0.16 || S.t > 8) { st.vx = 0; st.wz = 0; advance(); return true; }
        let err = Math.atan2(dy, dx) - st.yaw;
        if (dir < 0) err += Math.PI;
        err = ((err + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        st.wz = clamp(err * 2.0, -1.5, 1.5);
        /* On ralentit tant qu'on n'est pas dans l'axe — braquer à pleine
           vitesse ferait déraper le robot au lieu de le placer. Une petite
           correction se prend EN roulant, à pleine allure : c'est ce qui
           donne le liant. Un demi-tour, non : à 55 % de la vitesse le rayon
           de braquage dépasse la distance à la cible et le robot tourne
           autour sans jamais l'atteindre — quatorze secondes à orbiter. */
        /* Au-delà d'un quart de tour d'écart, on pivote SUR PLACE. Une
           correction de cap se prend en roulant — c'est ce qui donne le
           liant —, mais un demi-tour pris en roulant décrit un arc plus
           large que la distance à la cible : le robot s'éloignait en
           tournant, et une liaison finissait à vingt mètres du parc. */
        const ae = Math.abs(err);
        st.vx = ae > 1.2 ? 0
          : Math.abs(step.v) * dir * (ae > 0.9 ? 0.30 : Math.max(0.55, Math.cos(err)));
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
        if (Math.abs(err) < 0.03 || S.t > 6) {
          st.wz = 0;
          /* Et on reprend le sens de marche à l'endroit. Le robot est à
             l'arrêt : « l'avant » est ici un choix libre, et le laisser en
             fakie coûtait cher — une liaison qui vise un point de côté
             calcule son braquage à l'envers, tourne du mauvais bord et s'en
             va. C'est le seul endroit du run où ce choix est gratuit. */
          if (Y.Natural.state) Y.Natural.state.dir = 1;
          advance();
        }
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
