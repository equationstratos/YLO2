/* =====================================================================
   YLO-2 — mode PLAY : piloter le robot au clavier ou à la manette

   Le reste du visualiseur se pilote à la souris, un réglage à la fois.
   PLAY, c'est l'inverse : les deux mains sur les commandes, les figures
   au bout des doigts. Deux sources au choix — le clavier, ou une manette
   de PS4 branchée en USB ou appairée en Bluetooth.

   La manette passe par l'API Gamepad du navigateur, qui est la même sur
   Ubuntu et sur Windows : le système présente la DualShock 4 sous la
   disposition « standard », et c'est cette disposition qu'on lit. Rien à
   installer, rien de spécifique à un système.

   Deux gestes demandent d'attendre un instant avant d'agir :

     · une flèche appuyée DEUX FOIS demande le salto double. On ne peut
       donc pas lancer le simple au premier appui — il faut laisser sa
       chance au second. Le simple part 260 ms plus tard ;
     · L1 et R1 ENSEMBLE demandent la pirouette. Même raison, 130 ms.

   C'est le prix d'un geste à deux temps : sans cette attente, un double
   salto commencerait toujours par un simple.
   ===================================================================== */
(function (Y) {
  "use strict";

  const DOUBLE_S = 0.30;            // fenêtre du double appui sur une flèche
  const BOTH_S = 0.13;              // fenêtre de L1 + R1
  const DEAD = 0.15;                // zone morte des sticks
  const TRIG = 0.12;                // seuil des gâchettes analogiques
  const VX_MAX = 2.2;               // m/s à fond de R2
  const WZ_MAX = 1.4;               // rad/s à fond de stick
  const HEIGHTS = [0.20, 0.25, 0.30];

  /**
   * Disposition « standard » de l'API Gamepad, celle que Chrome et Firefox
   * présentent pour une DualShock 4, en USB comme en Bluetooth.
   */
  const PAD = {
    cross: 0, circle: 1, square: 2, triangle: 3,
    l1: 4, r1: 5, l2: 6, r2: 7,
    up: 12, down: 13, left: 14, right: 15
  };

  /** Salto simple et salto double, pour chacune des quatre flèches. */
  const DIR = {
    up:    { one: "wheelfrontflip", two: "wheeldoublefrontflip" },
    down:  { one: "wheelflip", two: "wheeldoubleflip" },
    left:  { one: "wheelsideflipL", two: "wheeldoublesideflipL" },
    right: { one: "wheelsideflipR", two: "wheeldoublesideflipR" }
  };

  /**
   * La correspondance, sous forme de données : elle sert à la fois au
   * pilotage et au panneau qui l'affiche. Une seule source de vérité, donc
   * pas de panneau qui ment sur ce que fait la manette.
   */
  const MAP = [
    { pad: "✕", key: "Espace", act: "Saut — maintenir arme, lâcher détend" },
    { pad: "△", key: "H", act: "Hauteur de caisse" },
    { pad: "□", key: "C", act: "Cabrage (tenu)" },
    { pad: "○", key: "V", act: "Sur deux roues (tenu)" },
    { pad: "R2", key: "↑", act: "Accélérer" },
    { pad: "L2", key: "↓", act: "Freiner" },
    { pad: "L1", key: "A", act: "Double salto arrière" },
    { pad: "R1", key: "E", act: "540 McTwist" },
    { pad: "L1 + R1", key: "A + E", act: "Pirouette" },
    { pad: "↑ ↓ ← →", key: "Z S Q D", act: "Salto dans cette direction" },
    { pad: "flèche ×2", key: "touche ×2", act: "Salto double" },
    { pad: "Stick", key: "← →", act: "Tourner" }
  ];

  const S = {
    on: false, source: "clavier", padName: "", say: "", listeners: []
  };

  // état d'entrée : appuis précédents, gestes en attente, consigne courante
  const prev = {};
  const keys = {};
  let waitDir = null;               // { dir, t } — salto simple en attente
  let waitBoth = null;              // { side, t } — épaule simple en attente
  let heightStep = 1;
  let hooks = { setVx: null, setWz: null, setHeight: null, flash: null, mode: null };

  function emit() { S.listeners.forEach(function (fn) { fn(S); }); }

  function say(msg) {
    S.say = msg;
    if (hooks.flash) hooks.flash(msg);
    emit();
  }

  /** Lance une figure de roues, en signalant proprement les refus. */
  function fire(id, charge) {
    if (Y.Motion.state.mode !== "roues") return;
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
      return;                        // une figure à la fois
    }
    const ok = Y.Stunt.start(id, charge);
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

  /** Appui sur une épaule : L1 et R1 ensemble donnent la pirouette. */
  function pressShoulder(side) {
    if (waitBoth && waitBoth.side !== side) {
      waitBoth = null;
      fire("pirouette");
      return;
    }
    waitBoth = { side: side, t: now() };
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
    if (waitBoth && t - waitBoth.t >= BOTH_S) {
      const side = waitBoth.side; waitBoth = null;
      fire(side === "l" ? "wheeldoubleflip" : "wheeltwist540");
    }
  }

  /** Front montant : l'action part à l'appui, pas tant que le bouton tient. */
  function edge(name, down) {
    const was = !!prev[name];
    prev[name] = down;
    return down && !was;
  }

  function actOn(name, down) {
    if (name === "cross") {
      // Le saut chargé : l'appui arme, le relâchement détend. C'est le geste
      // du skate — on charge dans l'élan et on lâche sur la lèvre. La détente
      // se prend sur le front DESCENDANT : sur « bouton relâché » tout court,
      // la manette détendrait aussi un saut armé depuis le bandeau.
      const was = !!prev.cross;
      prev.cross = down;
      if (down && !was) fire("wheeljump", true);
      else if (!down && was) Y.Stunt.fire();
      return;
    }
    if (edge(name, down)) {
      if (name === "triangle") cycleHeight();
      if (name === "square") fire("wheelie");
      if (name === "circle") fire("sidestand");
      if (name === "l1") pressShoulder("l");
      if (name === "r1") pressShoulder("r");
      if (DIR[name]) pressDir(name);
    }
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
      if (S.padName) { S.padName = ""; emit(); }
      return;
    }
    if (S.padName !== gp.id) { S.padName = gp.id; emit(); }
    const b = gp.buttons, ax = gp.axes;
    const val = function (i) { const x = b[i]; return x ? (x.value || (x.pressed ? 1 : 0)) : 0; };
    const on = function (i) { const x = b[i]; return !!(x && x.pressed); };

    Object.keys(PAD).forEach(function (name) {
      if (name === "l2" || name === "r2") return;
      actOn(name, on(PAD[name]));
    });

    // gâchettes : analogiques, donc lues en valeur et pas en tout ou rien
    const brakeOn = val(PAD.l2) > TRIG;
    const gas = val(PAD.r2);
    if (hooks.setVx) hooks.setVx(brakeOn ? 0 : gas > TRIG ? gas * VX_MAX : 0);
    const stick = Math.abs(ax[0] || 0) > DEAD ? ax[0] : 0;
    if (hooks.setWz) hooks.setWz(-stick * WZ_MAX);
  }

  function stepKeys() {
    const gas = keys.ArrowUp ? 1 : 0;
    const brakeOn = !!keys.ArrowDown;
    if (hooks.setVx) hooks.setVx(brakeOn ? 0 : gas * VX_MAX);
    const turn = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);
    if (hooks.setWz) hooks.setWz(turn * WZ_MAX);
  }

  const KEYMAP = {
    " ": "cross", h: "triangle", c: "square", v: "circle",
    a: "l1", e: "r1", z: "up", s: "down", q: "left", d: "right"
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
      waitDir = null; waitBoth = null;
      if (hooks.mode) hooks.mode("roues");     // toutes ces figures sont sur roues
      emit();
      return true;
    },

    stop: function () {
      S.on = false; S.say = ""; S.padName = "";
      waitDir = null; waitBoth = null;
      if (hooks.setVx) hooks.setVx(0);
      if (hooks.setWz) hooks.setWz(0);
      emit();
    },

    /** Manette détectée en ce moment, quel que soit le mode choisi. */
    padPresent: function () { return !!findPad(); },

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
      return true;
    }
  };
})(window.YLO);
