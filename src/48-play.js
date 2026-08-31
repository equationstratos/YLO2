/* =====================================================================
   YLO-2 — mode PLAY : piloter le robot au clavier ou à la manette

   Le reste du visualiseur se pilote à la souris, un réglage à la fois.
   PLAY, c'est l'inverse : les deux mains sur les commandes, les figures
   au bout des doigts. Deux sources au choix — le clavier, ou une manette
   de PS4 branchée en USB ou appairée en Bluetooth.

   La manette passe par l'API Gamepad du navigateur, qui est la même sur
   Ubuntu et sur Windows. DualShock 4 (PS4) et DualSense (PS5) marchent l'une
   comme l'autre : le navigateur les présente normalement sous la disposition
   « standard », et c'est celle qu'on lit. Rien à installer, rien de
   spécifique à un système.

   Quand une manette n'est PAS déclarée standard — Firefox, ou Chrome sur un
   noyau Linux d'avant le pilote `hid-playstation` —, on lit la disposition
   HID Sony d'origine : ordre des boutons différent, croix directionnelle sur
   un axe « chapeau », gâchettes sur des axes. Le panneau dit laquelle des
   deux a été reconnue.

   Deux gestes se lisent en deux temps :

     · une flèche appuyée DEUX FOIS demande le salto double. On ne peut donc
       pas lancer le simple au premier appui — il faut laisser sa chance au
       second. Le simple part 300 ms plus tard. C'est le prix du geste : sans
       cette attente, un double salto commencerait toujours par un simple ;
     · L1 et R1 TENUES ENSEMBLE donnent la pirouette. Pas de fenêtre de temps
       ici : la figure simple d'une épaule part à son RELÂCHEMENT, donc tant
       qu'on tient la première, la porte reste ouverte à la seconde.

   Trois commandes se TIENNENT au lieu de se déclencher : carré et rond
   dressent le robot le temps qu'on veut, L1 + R1 font tourner la pirouette
   tant que les deux gâchettes restent enfoncées, et le clic du stick gauche
   enchaîne les saltos arrière jusqu'au relâchement. Pendant tout ce temps le
   robot continue de rouler, de tourner et de changer de hauteur.
   ===================================================================== */
(function (Y) {
  "use strict";

  const DOUBLE_S = 0.30;            // fenêtre du double appui sur une flèche
  /* Au-delà, un appui de tenue est « long ». Réglé SOUS la durée d'armement
     de la bascule (0,30 s) : tant que le robot se ramasse, les quatre roues au
     sol, le côté n'est pas engagé et on peut le désigner directement. Un appui
     long va donc sur l'autre paire d'emblée, sans passer par la première. */
  const LONG_S = 0.22;
  const SOLO_S = 0.40;              // au-delà, une épaule seule tenue part quand même
  const DEAD = 0.15;                // zone morte des sticks
  const TRIG = 0.12;                // seuil des gâchettes analogiques
  const VX_MAX = 2.2;               // m/s à fond de R2
  const REV_MAX = 1.4;              // m/s à fond de L2 : une marche arrière est lente
  const WZ_MAX = 1.4;               // rad/s à fond de stick
  const HEIGHTS = [0.20, 0.25, 0.30];
  const CAM_AZ = 2.2;               // rad/s de balayage à fond de stick droit
  const CAM_EL = 1.4;

  /**
   * Dispositions de manette.
   *
   * L'API Gamepad promet une disposition « standard » — croix 0, rond 1,
   * carré 2, triangle 3, L1 4, R1 5, L2 6, R2 7, clic des sticks 10 et 11,
   * croix directionnelle 12 à 15 — et c'est bien celle que Chrome présente
   * pour une DualShock 4 comme pour une DualSense, en USB comme en Bluetooth.
   * Une manette de PS5 marche donc telle quelle, sans rien changer.
   *
   * Mais la promesse n'est pas tenue partout. Firefox, et Chrome sur des
   * noyaux Linux d'avant le pilote `hid-playstation`, exposent la manette
   * telle que le HID Sony la décrit : `mapping` vide, carré en 0, croix en 1,
   * rond en 2, la croix directionnelle sur un AXE « chapeau » plutôt que sur
   * quatre boutons, et les gâchettes sur des axes au lieu de boutons.
   *
   * On lit donc ce que la manette DÉCLARE, et on choisit. Une disposition
   * inconnue retombe sur la standard : c'est le pari le plus sûr.
   */
  const LAYOUTS = {
    standard: {
      label: "disposition standard",
      button: { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5,
                share: 8, options: 9, l3: 10,
                r3: 11, up: 12, down: 13, left: 14, right: 15, ps: 16 },
      trigger: { l2: { btn: 6 }, r2: { btn: 7 } },
      stick: { lx: 0, rx: 2, ry: 3 },
      hat: -1
    },
    sony: {
      label: "disposition Sony brute",
      button: { square: 0, cross: 1, circle: 2, triangle: 3, l1: 4, r1: 5,
                share: 8, options: 9, l3: 10, r3: 11, ps: 12 },
      // en HID brut, les gâchettes sont analogiques sur des axes, à plat en -1
      trigger: { l2: { axis: 3 }, r2: { axis: 4 } },
      stick: { lx: 0, rx: 2, ry: 5 },
      hat: 9
    }
  };

  /** Les huit positions d'un axe « chapeau », dans l'ordre horaire. */
  const HAT = [["up"], ["up", "right"], ["right"], ["down", "right"],
               ["down"], ["down", "left"], ["left"], ["up", "left"]];

  /**
   * Quelle disposition pour cette manette ?
   *
   * `mapping === "standard"` est une déclaration du navigateur : on la croit.
   * Sinon, une manette Sony reconnue à son nom ou à son identifiant USB, avec
   * assez d'axes pour porter ses gâchettes, suit la disposition HID d'origine.
   */
  function layoutFor(gp) {
    if (gp.mapping === "standard") return LAYOUTS.standard;
    const id = (gp.id || "").toLowerCase();
    const sony = /dualsense|dualshock|playstation|wireless controller|054c|0ce6|0df2|09cc|05c4/.test(id);
    if (sony && gp.axes.length >= 6) return LAYOUTS.sony;
    return LAYOUTS.standard;
  }

  /** Salto simple et salto double, pour chacune des quatre flèches. */
  const DIR = {
    up:    { one: "wheelfrontflip", two: "wheeldoublefrontflip" },
    down:  { one: "wheelflip", two: "wheeldoubleflip" },
    left:  { one: "wheelsideflipL", two: "wheeldoublesideflipL" },
    right: { one: "wheelsideflipR", two: "wheeldoublesideflipR" },
    /* Le clic du stick DROIT donne les sauts vrillés : une fois le 180, deux
       fois le 360. Même geste que les saltos — un appui, la figure simple ;
       deux, la double — donc rien de nouveau à apprendre. */
    r3:    { one: "wheeljump180", two: "wheeljump360" }
  };

  /**
   * La correspondance, sous forme de données : elle sert à la fois au
   * pilotage et au panneau qui l'affiche. Une seule source de vérité, donc
   * pas de panneau qui ment sur ce que fait la manette.
   */
  const MAP = [
    { pad: "✕", key: "Espace", act: "Saut — tenir arme, lâcher détend ; tourner en armant fait pivoter" },
    { pad: "△", key: "H", act: "Hauteur de caisse" },
    { pad: "□", key: "C", act: "Cabrage : bref = roues arrière, long = roues avant, bref = repose" },
    { pad: "○", key: "V", act: "Deux roues : bref = flanc droit, long = flanc gauche, bref = repose" },
    { pad: "R2", key: "↑", act: "Accélérer" },
    { pad: "L2", key: "↓", act: "Freiner, puis marche arrière" },
    { pad: "L1", key: "A", act: "Double salto arrière — au champ de tir : TIR" },
    { pad: "PARTAGE", key: "F", act: "Champ de tir : figer le viseur sur la cible (rappui = libre)" },
    { pad: "OPTIONS", key: "O", act: "Champ de tir : déclarer la cible amie — tir interdit" },
    { pad: "PS", key: "P", act: "Champ de tir : le robot nettoie seul les cibles repérées (85 % de la vitesse)" },
    { pad: "R1", key: "E", act: "540 McTwist" },
    { pad: "L1 + R1", key: "A + E", act: "Pirouette / 360 en l'air" },
    { pad: "□ ○ pendant", key: "C V pendant", act: "…passe en tenue SANS cesser de tourner" },
    { pad: "✕ en tenue", key: "Espace en tenue", act: "Saut sur place, dans la position" },
    { pad: "Clic stick G", key: "T", act: "Salto arrière enchaîné (tenu)" },
    { pad: "Clic stick D", key: "R", act: "Saut 180" },
    { pad: "Clic stick D ×2", key: "R ×2", act: "Saut 360" },
    { pad: "↑ ↓ ← →", key: "Z S Q D", act: "Salto dans cette direction" },
    { pad: "flèche ×2", key: "touche ×2", act: "Salto double" },
    { pad: "— en l'air —", key: "— en l'air —", act: "les mêmes touches font tourner le vol" },
    { pad: "Stick gauche", key: "← →", act: "Tourner" },
    { pad: "Stick D", key: "souris", act: "Caméra" }
  ];

  const S = {
    on: false, source: "clavier", padName: "", padLayout: "", say: "", listeners: [],
    // enchaînement en cours, dernier enchaînement validé, total
    combo: [], last: "", score: 0, air: false
  };
  let pending = 0, wasAir = false;

  /**
   * Au sol, chaque bouton lance la figure du catalogue — avec son armement et
   * son propre envol. EN L'AIR, le même bouton ne relance rien : il ajoute une
   * ROTATION au vol en cours. C'est la bascule qui fait tout le jeu : on
   * quitte la lèvre d'abord, on choisit ensuite.
   */
  const AIRMAP = {
    wheelflip: "back", wheelfrontflip: "front",
    wheeldoubleflip: "double", wheeldoublefrontflip: "doublefront",
    wheelsideflipL: "sideL", wheelsideflipR: "sideR",
    wheeldoublesideflipL: "dsideL", wheeldoublesideflipR: "dsideR",
    wheeltwist540: "mctwist", pirouette: "spin360"
  };

  function clampUnit(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // état d'entrée : appuis précédents, gestes en attente, consigne courante
  const prev = {};
  const keys = {};
  const held = {};                  // instants d'appui des boutons de tenue
  let waitDir = null;               // { dir, t } — salto simple en attente
  let waitBoth = null;              // { side, t } — épaule simple en attente
  let heightStep = 1;
  let hooks = { setVx: null, setWz: null, setHeight: null, setBrake: null,
                look: null, flash: null, mode: null };

  function emit() { S.listeners.forEach(function (fn) { fn(S); }); }

  function say(msg) {
    S.say = msg;
    if (hooks.flash) hooks.flash(msg);
    emit();
  }

  /** Lance une figure de roues, en signalant proprement les refus. */
  function fire(id, charge, hold) {
    if (Y.Motion.state.mode !== "roues") return;
    // en l'air, le bouton ajoute une rotation au vol au lieu d'en relancer un
    if (Y.Natural.wheelAirborne() && AIRMAP[id]) {
      const done = Y.Natural.trick(AIRMAP[id]);
      if (!done && !Y.Natural.tricking()) say("Trop bas pour tourner");
      return;
    }
    const f = Y.Stunt.figures[id];
    if (!f) return;
    if (Y.Stunt.active) {
      // Une tenue se repose au lieu d'être coupée : c'est ce qui fait du
      // carré et du rond des interrupteurs plutôt que des impulsions. On
      // demande le repos même pendant la montée — la couche figure sait le
      // mettre en attente — sinon un second appui trop rapide ne faisait
      // rien et le robot restait dressé.
      if (Y.Stunt.active === id && f.sustain && Y.Stunt.release()) {
        say(f.label + " — repos");
        return;
      }
      /* Une pirouette qu'on prolonge en tenue : le robot bascule sur deux
         roues SANS cesser de tourner. C'est le seul enchaînement où deux
         figures se superposent au lieu de se remplacer — elles n'agissent
         pas sur les mêmes choses, l'une sur le lacet, l'autre sur l'assiette
         et l'appui. */
      if (Y.Stunt.active === "pirouette" && f.kind === "tilt") {
        const done = Y.Stunt.chain(id);
        if (done === "pente") { say("Sol non plat : tenue refusée"); return; }
        if (done) say(f.label + " en tournant");
        return;
      }
      return;                        // une figure à la fois
    }
    const ok = Y.Stunt.start(id, charge, hold);
    if (ok === "pente") { say("Sol non plat : tenue refusée"); return; }
    if (ok) say(f.label);
  }

  /** Passe à la hauteur de caisse suivante : basse, normale, haute. */
  function cycleHeight() {
    heightStep = (heightStep + 1) % HEIGHTS.length;
    if (hooks.setHeight) hooks.setHeight(HEIGHTS[heightStep]);
    say("Hauteur " + Math.round(HEIGHTS[heightStep] * 1000) + " mm");
  }

  /**
   * Appui sur une flèche. Le premier appui met le salto simple EN ATTENTE ;
   * si la même flèche revient dans la fenêtre, c'est le double qui part et
   * l'attente est annulée.
   */
  function pressDir(dir) {
    if (waitDir && waitDir.dir === dir) {
      waitDir = null;
      fire(DIR[dir].two);
      return;
    }
    waitDir = { dir: dir, t: now() };
  }

  /**
   * Appui sur une épaule. L1 et R1 ENSEMBLE donnent la pirouette.
   *
   * « Ensemble » veut dire les deux TENUES, pas les deux appuyées dans la même
   * fenêtre de temps. C'est ce que fait la main : on garde la première et on
   * ajoute la seconde. Une fenêtre de 130 ms demandait deux doigts synchrones
   * au dixième de seconde près — en pratique la première épaule partait seule
   * en salto avant que la seconde n'arrive.
   *
   * La figure simple d'une épaule part donc au RELÂCHEMENT, pas après un
   * minuteur : un appui bref reste un appui bref, et tant qu'on tient, la
   * porte reste ouverte à la pirouette. Le minuteur ne sert plus que de
   * filet — au bout de 0,40 s, une épaule tenue seule part quand même, sinon
   * la garder enfoncée aurait l'air de ne rien faire.
   */
  function pressShoulder(side) {
    /* Au champ de tir, L1 n'est plus une figure : c'est la détente. Le robot
       y porte une arme et la visée est automatique — il n'y a rien à cadrer,
       seulement à choisir le moment. Ailleurs, L1 garde son double salto. */
    if (side === "l" && Y.Range.active()) {
      if (Y.Range.fire()) say("Rafale");
      return;
    }
    if (prev[side === "l" ? "r1" : "l1"]) {        // l'autre est déjà tenue
      waitBoth = null;
      /* Déjà en tenue ? On ne relance pas une pirouette à sa place : on la
         fait tourner SUR PLACE, cabrée ou sur le flanc. L'enchaînement marche
         donc dans les deux sens — partir en vrille puis basculer, ou se
         dresser d'abord et se mettre à tourner ensuite. */
      if (Y.Stunt.twirlStart()) { say("Pirouette en position"); return; }
      fire("pirouette", false, true);
      return;
    }
    waitBoth = { side: side, t: now() };
  }

  /** La figure simple d'une épaule : double salto à gauche, McTwist à droite. */
  function shoulderSolo(side) {
    fire(side === "l" ? "wheeldoubleflip" : "wheeltwist540");
  }

  /**
   * Les deux attentes se comptent à l'HORLOGE, pas au pas de rendu.
   *
   * Un doigt ne ralentit pas quand la carte graphique peine : sur une machine
   * qui tombe à huit images par seconde, un pas de rendu plafonné à 50 ms
   * étirait la fenêtre du double appui à plus d'une demi-seconde réelle, et
   * le geste ne répondait plus pareil selon la scène affichée.
   */
  function now() { return performance.now() / 1000; }

  function resolvePending() {
    const t = now();
    if (waitDir && t - waitDir.t >= DOUBLE_S) {
      const d = waitDir.dir; waitDir = null; fire(DIR[d].one);
    }
    if (waitBoth && t - waitBoth.t >= SOLO_S) {
      const side = waitBoth.side; waitBoth = null;
      shoulderSolo(side);
    }
  }

  /** Front montant : l'action part à l'appui, pas tant que le bouton tient. */
  function edge(name, down) {
    const was = !!prev[name];
    prev[name] = down;
    return down && !was;
  }

  function actOn(name, down) {
    if (name === "l1" || name === "r1") {
      const was = !!prev[name];
      prev[name] = down;
      const side = name === "l1" ? "l" : "r";
      if (down && !was) { pressShoulder(side); return; }
      // Tant que la gâchette TIENT, il ne se passe rien de plus. Sans cette
      // ligne, la pirouette était relâchée à l'image suivant son départ —
      // toujours enfoncée, mais déjà arrêtée : elle ne tournait jamais.
      if (down && was && side === "l" && Y.Range.active()) {
        // gâchette tenue : les rafales s'enchaînent, la cadence les espace
        if (Y.Range.fire()) say("Rafale");
        return;
      }
      if (down || !was) return;
      // Front descendant : le premier relâchement arrête la pirouette.
      if (Y.Stunt.active === "pirouette") { Y.Stunt.release(); return; }
      // vrille passée à une tenue : lâcher les épaules la freine
      if (Y.Stunt.twirling()) { Y.Stunt.twirlRelease(); return; }
      // Sinon c'était un appui bref sur une seule épaule : sa figure part
      // maintenant, au relâchement.
      if (waitBoth && waitBoth.side === side) { waitBoth = null; shoulderSolo(side); }
      return;
    }
    /* Les deux boutons plats de la manette ne servent qu'au champ de tir, et
       ils y disent la seule chose que la visée automatique ne sait pas :
       QUOI viser. PARTAGE fige le viseur sur la cible tenue — la tourelle
       continue de la suivre au lieu de repartir vers la plus proche —,
       OPTIONS la déclare amie et la sort définitivement du cycle. */
    if (name === "share" || name === "options") {
      if (!edge(name, down)) return;
      if (!Y.Range.active()) return;
      if (name === "share") { if (Y.Range.hold()) say(Y.Range.state.say); }
      else if (Y.Range.spare()) say("Cible amie — on ne tire plus dessus");
      return;
    }
    /* La touche PS rend la main au robot : il prend les cibles de sa carte
       une par une, en se déplaçant s'il le faut. Un second appui la lui
       reprend, à l'image près — on ne lance pas un automate qu'on ne peut
       pas arrêter. */
    if (name === "ps") {
      if (!edge(name, down)) return;
      if (Y.Range.active() && Y.Range.sweep()) say(Y.Range.state.say);
      return;
    }
    if (name === "l3") {
      // Clic du stick gauche : la bascule enchaînée tourne tant qu'on tient.
      const was = !!prev.l3;
      prev.l3 = down;
      if (down && !was) fire("wheeltumble", false, true);
      else if (!down && was && Y.Stunt.active === "wheeltumble") Y.Stunt.release();
      return;
    }
    if (name === "cross") {
      // Le saut chargé : l'appui arme, le relâchement détend. C'est le geste
      // du skate — on charge dans l'élan et on lâche sur la lèvre. La détente
      // se prend sur le front DESCENDANT : sur « bouton relâché » tout court,
      // la manette détendrait aussi un saut armé depuis le bandeau.
      const was = !!prev.cross;
      prev.cross = down;
      if (down && !was) {
        /* En tenue, la croix ne relance pas un saut au sol : elle arme un saut
           SUR PLACE, dans la position. Cabré ou sur le flanc, le robot se
           ramasse tant qu'on tient, puis quitte le sol et y retombe sans rien
           défaire — le même geste que le saut normal, troisième étage de
           l'enchaînement vrille + tenue + saut. */
        if (Y.Stunt.hop()) { say("Saut en position — lâcher pour détendre"); return; }
        fire("wheeljump", true);
      } else if (!down && was) {
        if (Y.Stunt.hopFire()) return;
        Y.Stunt.fire();
      }
      return;
    }
    /* Carré et rond : appui BREF d'un côté, appui LONG de l'autre.
       Un appui bref pose le robot sur ses roues arrière (carré) ou sur son
       flanc droit (rond). En gardant le bouton, il redescend et repart sur
       les roues avant, ou sur l'autre flanc. Et un appui bref pendant la
       tenue le repose, quel que soit le côté levé — c'est le même bouton qui
       met et qui enlève, comme un interrupteur. */
    if (name === "square" || name === "circle") {
      const id = name === "square" ? "wheelie" : "sidestand";
      const was = !!prev[name];
      prev[name] = down;
      if (down && !was) { held[name] = now(); fire(id); }
      else if (!down && was) held[name] = 0;
      return;
    }
    if (edge(name, down)) {
      if (name === "triangle") cycleHeight();
      if (DIR[name]) pressDir(name);
    }
  }

  /**
   * Bouton de tenue gardé enfoncé : on demande l'autre paire de roues.
   *
   * Le geste se juge sur la DURÉE et non au relâchement : décider à la levée
   * du doigt ferait attendre le robot, et on veut le voir passer d'un appui à
   * l'autre pendant qu'on appuie.
   */
  function resolveHold() {
    ["square", "circle"].forEach(function (name) {
      if (!held[name]) return;
      const id = name === "square" ? "wheelie" : "sidestand";
      if (Y.Stunt.active !== id) { held[name] = 0; return; }
      if (now() - held[name] < LONG_S) return;
      held[name] = 0;
      /* Pendant l'armement, on DÉSIGNE le côté — le robot part directement sur
         l'autre paire. Passé l'armement, il est déjà dressé : il ne reste que
         la bascule, qui le fait redescendre et remonter de l'autre côté. */
      if (Y.Stunt.setSide(-1) || Y.Stunt.swapSide()) {
        say(id === "wheelie" ? "Sur les roues avant" : "Sur l'autre flanc");
      }
    });
  }

  /** Manette branchée, s'il y en a une : la première connectée gagne. */
  function findPad() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].connected) return list[i];
    }
    return null;
  }

  function stepPad() {
    const gp = findPad();
    if (!gp) {
      if (S.padName) { S.padName = ""; S.padLayout = ""; emit(); }
      return;
    }
    const L = layoutFor(gp);
    if (S.padName !== gp.id || S.padLayout !== L.label) {
      S.padName = gp.id; S.padLayout = L.label; emit();
    }
    const b = gp.buttons, ax = gp.axes;
    const on = function (name) {
      const i = L.button[name];
      if (i === undefined) return false;
      const x = b[i];
      return !!(x && x.pressed);
    };
    /** Gâchette analogique, qu'elle soit sur un bouton ou sur un axe. */
    const trig = function (name) {
      const t = L.trigger[name];
      if (!t) return 0;
      if (t.btn !== undefined) {
        const x = b[t.btn];
        return x ? (x.value || (x.pressed ? 1 : 0)) : 0;
      }
      const v = ax[t.axis];
      // sur un axe, une gâchette au repos vaut -1 et non 0
      return v === undefined ? 0 : clampUnit((v + 1) / 2);
    };

    // croix directionnelle : quatre boutons, ou un axe « chapeau »
    const dpad = { up: false, down: false, left: false, right: false };
    if (L.hat >= 0) {
      const v = ax[L.hat];
      if (v !== undefined && v >= -1.01 && v <= 1.01) {
        HAT[Math.min(7, Math.max(0, Math.round((v + 1) * 3.5)))]
          .forEach(function (d) { dpad[d] = true; });
      }
    } else {
      ["up", "down", "left", "right"].forEach(function (d) { dpad[d] = on(d); });
    }

    ["cross", "circle", "square", "triangle", "l1", "r1", "l3", "r3",
     "share", "options", "ps"]
      .forEach(function (name) { actOn(name, on(name)); });
    ["up", "down", "left", "right"].forEach(function (d) { actOn(d, dpad[d]); });

    // les gâchettes sont analogiques : un dosage, pas un tout ou rien
    drive(trig("r2"), trig("l2"));
    const lx = ax[L.stick.lx] || 0;
    const stick = Math.abs(lx) > DEAD ? lx : 0;
    if (hooks.setWz && !Y.Range.autopilot()) hooks.setWz(-stick * WZ_MAX);

    /* Stick droit : la caméra. On envoie une VITESSE de rotation, que
       l'application intègre avec son propre pas de temps — un stick tenu à
       fond doit balayer autant de degrés par seconde quel que soit le
       nombre d'images affichées. */
    const rxv = ax[L.stick.rx] || 0, ryv = ax[L.stick.ry] || 0;
    const rx = Math.abs(rxv) > DEAD ? rxv : 0;
    const ry = Math.abs(ryv) > DEAD ? ryv : 0;
    if (hooks.look) hooks.look(rx * CAM_AZ, ry * CAM_EL);
  }

  /**
   * Les deux gâchettes : R2 pousse, L2 retient PUIS recule.
   *
   * L2 fait les deux parce que c'est la pédale gauche d'un jeu de course :
   * tant que le robot avance elle freine, et une fois arrêté elle passe la
   * marche arrière. Une seule gâchette suffit donc pour les deux, sans en
   * voler une autre au catalogue de figures.
   *
   * Le sens réel se lit sur la vitesse du robot, pas sur la consigne : après
   * un 540 il roule en fakie, sa marche avant est inversée, et c'est cette
   * marche avant-là que le frein doit retenir.
   */
  function drive(gas, brk) {
    /* Pendant un nettoyage automatique, les gâchettes ne conduisent plus :
       c'est le robot qui pilote, et deux consignes de vitesse sur la même
       image se battraient en duel à soixante images par seconde. Les figures,
       elles, restent disponibles — arrêter le nettoyage n'est pas la seule
       chose qu'on doit pouvoir faire pendant qu'il tourne. */
    if (Y.Range.autopilot()) return;
    const rolling = Y.Natural.state.vx * (Y.Natural.state.dir || 1) > 0.05;
    const braking = brk > TRIG && rolling;
    /* Relâcher les DEUX gâchettes freine. Un skateur roule sur son erre, mais
       un robot qu'on pilote doit s'arrêter quand on lâche tout : sans ça, la
       moindre pente l'emmène et on passe son temps à le rattraper. Le frein
       tenu coupe aussi la gravité et le pompage — c'est un frein, il tient. */
    const idle = gas <= TRIG && brk <= TRIG;
    if (hooks.setBrake) hooks.setBrake(braking || idle);
    let v = gas > TRIG ? gas * VX_MAX : 0;
    if (brk > TRIG && !rolling) v -= brk * REV_MAX;
    if (hooks.setVx) hooks.setVx(v);
  }

  /**
   * Enchaînements et score.
   *
   * Une figure bouclée en l'air s'ajoute à l'enchaînement ; une figure qu'on
   * n'a pas fini de tourner avant de toucher fait tout perdre. À la réception,
   * l'enchaînement est validé et multiplié par le nombre de figures : deux
   * figures dans le même saut valent quatre fois une seule. C'est ce qui
   * pousse à en tenter une de plus au lieu de se poser.
   */
  function stepCombo() {
    const air = Y.Natural.wheelAirborne();
    let l = Y.Natural.takeLanding();
    while (l) {
      if (l.ok) { S.combo.push(l.label); pending += l.score; say(l.label); }
      else {
        S.combo.length = 0; pending = 0;
        say("Chute — " + l.label + " pas bouclé");
      }
      l = Y.Natural.takeLanding();
    }
    if (wasAir && !air && S.combo.length) {
      const mult = S.combo.length;
      const won = pending * mult;
      S.score += won;
      S.last = S.combo.join(" + ") + (mult > 1 ? " ×" + mult : "");
      say(S.last + "   +" + won);
      S.combo.length = 0; pending = 0;
    }
    if (S.air !== air) { S.air = air; emit(); }
    wasAir = air;
  }

  function stepKeys() {
    drive(keys.ArrowUp ? 1 : 0, keys.ArrowDown ? 1 : 0);
    if (Y.Range.autopilot()) return;
    const turn = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);
    if (hooks.setWz) hooks.setWz(turn * WZ_MAX);
  }

  const KEYMAP = {
    " ": "cross", h: "triangle", c: "square", v: "circle",
    a: "l1", e: "r1", t: "l3", r: "r3", f: "share", o: "options", p: "ps",
    z: "up", s: "down", q: "left", d: "right"
  };

  Y.Play = {
    map: MAP,
    state: S,
    heights: HEIGHTS,
    onChange: function (fn) { S.listeners.push(fn); },

    /** L'application fournit ses commandes : PLAY n'écrit pas dans le DOM. */
    bind: function (h) { hooks = Object.assign(hooks, h); },

    start: function (source) {
      S.source = source === "manette" ? "manette" : "clavier";
      S.on = true;
      Object.keys(prev).forEach(function (k) { prev[k] = false; });
      Object.keys(keys).forEach(function (k) { delete keys[k]; });
      waitDir = null; waitBoth = null; held.square = 0; held.circle = 0;
      if (hooks.mode) hooks.mode("roues");     // toutes ces figures sont sur roues
      if (hooks.setBrake) hooks.setBrake(false);
      S.combo.length = 0; S.last = ""; S.score = 0; pending = 0; wasAir = false;
      // Roue libre : en PLAY, la gravité agit le long des pentes et le sol
      // peut se dérober. C'est ce qui fait qu'une big ramp se roule.
      Y.Natural.setFreeRoll(true);
      emit();
      return true;
    },

    stop: function () {
      S.on = false; S.say = ""; S.padName = "";
      waitDir = null; waitBoth = null; held.square = 0; held.circle = 0;
      if (hooks.setVx) hooks.setVx(0);
      if (hooks.setWz) hooks.setWz(0);
      if (hooks.setBrake) hooks.setBrake(false);
      Y.Natural.setFreeRoll(false);
      emit();
    },

    /** Manette détectée en ce moment, quel que soit le mode choisi. */
    padPresent: function () { return !!findPad(); },

    /** Disposition retenue pour une manette donnée — exposée pour les essais. */
    layoutOf: function (gp) { return layoutFor(gp || findPad() || { axes: [] }).label; },

    /**
     * Touche du clavier en mode PLAY. Rend `true` si PLAY s'en est saisi :
     * l'application suspend alors ses propres raccourcis, sinon `C` replierait
     * le bandeau au lieu de cabrer le robot.
     */
    key: function (k, down) {
      if (!S.on || S.source !== "clavier") return false;
      if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") {
        keys[k] = down;
        return true;
      }
      const name = KEYMAP[k.length === 1 ? k.toLowerCase() : k];
      if (!name) return false;
      actOn(name, down);
      return true;
    },

    step: function (dt) {
      if (!S.on) return false;
      if (S.source === "manette") stepPad(); else stepKeys();
      resolvePending();
      resolveHold();
      stepCombo();
      return true;
    },

    /** Remet le compteur à zéro : nouveau parcours, nouvelle ardoise. */
    resetScore: function () {
      S.combo.length = 0; S.last = ""; S.score = 0;
      pending = 0; wasAir = false;
      emit();
    }
  };
})(window.YLO);
