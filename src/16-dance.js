/* =====================================================================
   YLO-2 — le Shuffle

   Un running man de quadrupède, SUR PLACE.

   Le principe tient en une phrase : les deux diagonales glissent en sens
   OPPOSÉS. Pendant qu'une diagonale recule au sol, chargée, l'autre revient
   vers l'avant à peine décollée — puis elles échangent. Ce sont les pieds qui
   défilent sous la caisse et non la caisse qui avance sur les pieds ; c'est
   l'inverse exact d'une marche, et c'est toute l'illusion.

   Trois choses font que ça se lit comme une danse et pas comme un bug :

     · le CONTACT NE SE ROMPT JAMAIS. Deux pieds au moins portent en
       permanence, et le poids passe de l'un à l'autre sans que le robot
       quitte le sol. Une version précédente sautait pour échanger ses
       diagonales en l'air : c'était juste mécaniquement, mais on y voyait
       un saut, pas un shuffle.
     · la FRÉQUENCE. 0,42 s le cycle complet, donc un pas toutes les 210 ms —
       près de trois cents tapotements à la minute. En dessous, le pas
       redevient une marche ; c'est la vitesse qui fait le style.
     · le REBOND. La caisse monte et descend une fois PAR PAS, et non par
       cycle : le rebond bat à deux fois la fréquence de la danse, ce qui le
       synchronise avec le tapotement et non avec l'alternance.

   Le tout se danse dans le train où l'on est : sur pattes le pied glisse,
   sur roues le pneu dérape. C'est même plus juste sur roues — une roue qui
   glisse ne triche pas.
   ===================================================================== */
(function (Y) {
  "use strict";

  const K = Y.K;

  /* Le cycle complet, deux pas. 0,42 s : le rythme d'un running man, deux
     fois plus vif qu'une marche de robot. */
  const CYCLE = 0.42;
  const CYCLES = 15;                 // un peu plus de six secondes de pas

  /* Amplitudes, en mètres et en radians. Une danse de robot se lit au RYTHME
     bien plus qu'à l'amplitude, et tout ce qui dépasse l'enveloppe de travail
     se fait écrêter de toute façon — autant rester dedans. */
  const SLIDE = 0.080;               // demi-course du glissement avant/arrière
  const TAP = 0.026;                 // décollage du pied qui revient
  const BOUNCE = 0.024;              // rebond vertical de la caisse
  const ROLL = 0.055;                // report de poids sur la diagonale chargée
  const PITCH = 0.030;               // tangage du rebond
  const WAG = 0.055;                 // lacet de caisse, le déhanché
  const GATHER = 0.010;              // les appuis se resserrent sous la caisse

  /* Les deux diagonales, avec les identifiants du dépôt : `lf` avant-gauche,
     `rh` arrière-droit, et l'autre paire. */
  const DIAG = [["lf", "rh"], ["rf", "lh"]];

  const S = {
    on: false, t: 0, say: "", beat: 0, cyc: 0,
    back: null, modeFn: null, x0: 0, y0: 0, yaw0: 0, wheels: false, last: {}
  };

  function ease(u) { return u * u * (3 - 2 * u); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }

  /** La patte est-elle dans la diagonale d'appui de ce cycle ? */
  function inDiag(id, d) { return DIAG[d][0] === id || DIAG[d][1] === id; }

  /**
   * Le pas, image par image.
   *
   * On rend, pour chaque patte, la position du pied dans le repère
   * horizontal du robot, plus son état d'appui. Tout le reste — assiette,
   * hauteur de caisse, cap — est écrit dans `state` au passage.
   */
  Y.Dance = {
    state: S,
    duration: CYCLE * CYCLES,

    start: function (modeFn) {
      if (S.on) return false;
      const st = Y.Motion.state;
      S.modeFn = modeFn || null;
      S.back = { mode: st.mode, gait: st.gait, height: st.height,
                 swing: st.swing, vx: st.vx, vy: st.vy, wz: st.wz,
                 roll: st.roll, pitch: st.pitch };
      if (Y.Stunt) Y.Stunt.stop(false);
      if (Y.Natural) { Y.Natural.setFreeRoll(false); Y.Natural.setBrake(true); }
      /* On danse dans le train où l'on est. Sur pattes le pied gratte, sur
         roues le pneu dérape — c'est le même pas, et changer de train pour
         danser reviendrait à refuser la moitié de la demande. */
      S.wheels = st.mode === "roues";
      st.vx = 0; st.vy = 0; st.wz = 0;
      S.x0 = st.px; S.y0 = st.py; S.yaw0 = st.yaw;
      S.on = true; S.t = 0; S.cyc = 0; S.say = "Shuffle"; S.last = {};
      return true;
    },

    stop: function () {
      if (!S.on) return;
      const st = Y.Motion.state, b = S.back;
      S.on = false; S.say = "";
      if (!b) return;
      st.vx = 0; st.vy = 0; st.wz = 0;
      st.gait = b.gait; st.height = b.height; st.swing = b.swing;
      st.roll = 0; st.pitch = 0; st.yawWag = 0; st.sway = 0;
      if (Y.Natural) { Y.Natural.reset(); Y.Natural.setBrake(false); }
      S.back = null;
    },

    dancing: function () { return S.on; },

    /** Avance l'horloge. Appelé avant le pas de simulation. */
    step: function (dt) {
      if (!S.on) return false;
      S.t += dt;
      if (S.t >= Y.Dance.duration) { Y.Dance.stop(); return false; }
      return true;
    },

    /**
     * Écrit l'assiette et les quatre appuis. Appelé PAR le pas de
     * simulation, à la place du générateur d'allure.
     */
    pose: function (dt, st) {
      const T = Math.min(S.t, Y.Dance.duration);
      const cyc = Math.floor(T / CYCLE);
      const u = (T % CYCLE) / CYCLE;             // 0 → 1 sur le cycle complet
      const half = u < 0.5 ? 0 : 1;              // quel demi-pas
      const v = (u - half * 0.5) * 2;            // 0 → 1 dans le demi-pas
      S.cyc = cyc;
      S.beat = half + 1;

      /* Fondu d'entrée et de sortie : le pas ne commence ni ne finit sur une
         amplitude pleine, sinon la première image est un à-coup. */
      const fade = Math.min(1, T / 0.28, (Y.Dance.duration - T) / 0.35);

      /* La diagonale CHARGÉE de ce demi-pas : c'est elle qui est au sol et qui
         recule. L'autre revient vers l'avant en effleurant. */
      const load = half;
      const side = load === 0 ? 1 : -1;

      /* --- caisse ---
         Le rebond bat une fois par PAS, donc deux fois par cycle : c'est ce
         qui le synchronise avec le tapotement. Il est au plus bas quand le
         pied qui revient se repose — le poids arrive, la caisse s'écrase —
         et au plus haut au milieu du glissement. */
      const bob = -Math.cos(v * Math.PI * 2) * BOUNCE;
      const ride = 0.235;
      const WR = S.wheels ? 0.075 : 0;

      /* Sur place, strictement : le cap et la position ne bougent pas. */
      st.px = S.x0; st.py = S.y0; st.yaw = S.yaw0;
      const ground = Y.Terrain ? Y.Terrain.heightAt(st.px, st.py) : 0;
      st.z = ground + ride + WR + bob * fade;

      /* Report de poids, doux : le roulis suit la diagonale chargée et passe
         de l'une à l'autre en sinusoïde, sans marche d'escalier. */
      const w = Math.sin(u * Math.PI * 2);
      st.roll = lerp(st.roll, -w * ROLL * fade, Math.min(1, dt * 22));
      st.pitch = lerp(st.pitch, Math.sin(v * Math.PI * 2 + 0.6) * PITCH * fade,
                      Math.min(1, dt * 22));
      st.yawWag = w * WAG * fade;
      st.sway = 0;

      /* --- les pieds ---
         Chaque diagonale fait, sur un cycle complet, un aller-retour : elle
         recule en portant pendant son demi-pas chargé, elle revient vers
         l'avant pendant l'autre. Les deux sont donc toujours en opposition de
         phase — l'une va vers l'arrière quand l'autre va vers l'avant. */
      const feet = {};
      Y.LEGS.forEach(function (L) {
        const id = L.id;
        const nx = L.x, ny = L.y + L.m * K.abadPlane;
        const charged = DIAG[load][0] === id || DIAG[load][1] === id;

        let x, z = -ride, contact = 1, lift = 0;
        if (charged) {
          /* CHARGÉE : elle part de l'avant et recule au sol, pied collé.
             C'est ce glissement-là qu'on voit, et c'est lui qui porte. */
          x = nx + lerp(SLIDE, -SLIDE, ease(v));
        } else {
          /* LIBRE : elle revient vers l'avant en effleurant. Le décollage est
             une bosse courte au milieu du trajet — un tapotement, pas une
             enjambée : le pied repose avant la fin du demi-pas, et le contact
             ne se rompt donc jamais des deux côtés à la fois. */
          x = nx + lerp(-SLIDE, SLIDE, ease(v));
          lift = Math.sin(Math.PI * clamp((v - 0.12) / 0.66, 0, 1)) * TAP;
          contact = lift < TAP * 0.25 ? 1 : 0;
        }
        z = -ride + lift;

        /* Les appuis se resserrent LÉGÈREMENT sous la caisse du côté chargé :
           c'est ce qui garde le centre de masse au milieu du polygone pendant
           que le poids passe d'une diagonale à l'autre. */
        const y = ny - side * GATHER * (charged ? 1 : -0.4) * fade;

        // amplitude fondue au départ et à l'arrivée
        const xf = nx + (x - nx) * fade;
        const yf = ny + (y - ny) * fade;
        const zf = -ride + (z + ride) * fade;

        feet[id] = [xf, yf, zf, contact, u, zf - WR];
      });

      Y.Natural.placeFeet(st, feet);

      /* Les roues tournent avec ce que le pneu parcourt : un shuffle sur
         roues, c'est un pneu qui glisse ET une roue qui roule, et une roue
         figée pendant un dérapage se voit tout de suite. */
      if (S.wheels) {
        Y.LEGS.forEach(function (L) {
          const n = Y.Robot.legs[L.id];
          if (!n.wheel) return;
          const px = S.last[L.id];
          if (px !== undefined) n.wheel.rotation.y -= (feet[L.id][0] - px) / 0.075;
          S.last[L.id] = feet[L.id][0];
        });
      }

      S.say = half === 0 ? "Shuffle · gauche" : "Shuffle · droite";
    }
  };
})(window.YLO);
