/* =====================================================================
   YLO-2 — le Shuffle

   Le pas de danse sur place des quadrupèdes de Boston Dynamics, relevé
   IMAGE PAR IMAGE sur une séquence de référence plutôt que deviné.

   Trois mesures ont tout décidé, et deux d'entre elles ont contredit ce que
   je croyais :

     · le REBOND bat toutes les 480 ms — 125 à la minute. Deux fois plus
       lent que ce que j'avais écrit : à trois cents tapotements minute, le
       pas n'était plus lisible, juste nerveux.
     · son AMPLITUDE vaut 28 % de la hauteur au garrot (171 mm sur un robot
       qui se tient à 610). Ramenée à YLO-2, qui roule à 235 mm de garde,
       cela fait 66 mm de battement : quatre fois ce que j'avais mis. Ce
       rebond-là est l'essentiel du mouvement, pas un ornement.
     · les pattes s'ÉCARTENT QUAND LA CAISSE DESCEND et se rassemblent quand
       elle monte. C'est l'inverse de ce que j'avais fait, et c'est
       simplement de la géométrie : une patte de longueur donnée porte moins
       haut quand elle est oblique. Le robot se détend en rassemblant ses
       appuis sous lui et s'écrase en les ouvrant — ressort, pas ciseaux.

   S'y ajoute une ASSIETTE qui bascule de 16° d'un bord à l'autre, à la
   moitié de la fréquence du rebond : un rebond nez haut, le suivant nez bas.
   C'est elle qui donne son insolence au pas.

   Le contact ne se rompt jamais : les quatre pieds raclent le sol pendant
   toute la danse. Un léger décalage gauche/droite empêche le pas d'être
   parfaitement symétrique — sans lui, on voit une machine qui pompe et non
   un robot qui danse.

   Le tout se danse dans le train où l'on est : sur pattes le pied racle, sur
   roues le pneu dérape. C'est même plus juste sur roues — une roue qui
   glisse ne triche pas.
   ===================================================================== */
(function (Y) {
  "use strict";

  const K = Y.K;

  /* Un rebond. Mesuré à 480 ms sur la séquence de référence. */
  const BEAT = 0.48;
  const BEATS = 14;                  // un peu moins de sept secondes de pas

  /* Amplitudes, en mètres et en radians. Le rebond et l'écartement sont
     relevés ; le reste les accompagne. */
  const RIDE = 0.235;                // garde moyenne
  const BOUNCE = 0.033;              // demi-battement : 66 mm bout à bout
  const OPEN = 0.075;                // ouverture des appuis, caisse basse
  const GATHER = 0.028;              // rassemblement des appuis, caisse haute
  const PITCH = 0.14;                // assiette : 16° bout à bout
  const ROLL = 0.030;                // roulis du décalage gauche/droite
  const WAG = 0.040;                 // lacet de caisse
  const SKEW = 0.13;                 // décalage de phase gauche/droite
  const SCUFF = 0.012;               // raclement latéral des pieds

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
    duration: BEAT * BEATS,

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
      const n = T / BEAT;                        // rebonds écoulés, en continu
      const beat = Math.floor(n);
      S.cyc = beat; S.beat = (beat % 2) + 1;

      /* Fondu d'entrée et de sortie : le pas ne commence ni ne finit sur une
         amplitude pleine, sinon la première image est un à-coup. */
      const fade = Math.min(1, T / 0.35, (Y.Dance.duration - T) / 0.40);

      /* Le cycle du rebond, en radians. `-cos` place le CREUX au début de
         chaque rebond : la caisse touche son point bas au temps, remonte au
         milieu, et redescend. C'est ce phasage qui fait tomber le point bas
         sur la pulsation plutôt qu'entre deux. */
      const w = n * Math.PI * 2;
      const up = -Math.cos(w);                   // −1 en bas, +1 en haut

      /* Sur place, strictement : le cap et la position ne bougent pas. */
      st.px = S.x0; st.py = S.y0; st.yaw = S.yaw0;
      const ground = Y.Terrain ? Y.Terrain.heightAt(st.px, st.py) : 0;
      const WR = S.wheels ? 0.075 : 0;
      const ride = RIDE + up * BOUNCE * fade;
      st.z = ground + ride + WR;

      /* L'assiette bascule à la MOITIÉ de la fréquence du rebond : un rebond
         nez haut, le suivant nez bas. Le roulis, lui, suit le décalage
         gauche/droite des appuis. */
      st.pitch = lerp(st.pitch, Math.sin(w / 2) * PITCH * fade, Math.min(1, dt * 20));
      st.roll = lerp(st.roll, Math.sin(w - Math.PI / 2) * ROLL * fade, Math.min(1, dt * 20));
      st.yawWag = Math.sin(w / 2 + 0.8) * WAG * fade;
      st.sway = 0;

      /* --- les appuis ---
         Ils s'OUVRENT quand la caisse descend et se rassemblent quand elle
         monte : les pattes avant partent devant et les arrière derrière au
         creux du rebond, tout revient sous la caisse au sommet. Le décalage
         gauche/droite désynchronise légèrement les deux flancs. */
      const feet = {};
      Y.LEGS.forEach(function (L) {
        const id = L.id;
        const nx = L.x, ny = L.y + L.m * K.abadPlane;

        // phase propre à ce flanc : la gauche mène, la droite suit
        const ph = w + (L.m > 0 ? -SKEW : SKEW) * Math.PI;
        const open = (1 - Math.cos(ph)) / 2;      // 0 rassemblé, 1 ouvert
        const spread = lerp(-GATHER, OPEN, open) * L.f;

        const x = nx + spread * fade;
        // les pieds raclent aussi vers l'extérieur en s'ouvrant : c'est ce
        // frottement latéral qui fait crisser le pas plutôt que le sautiller
        const y = ny + L.m * open * SCUFF * fade;
        const z = -ride;

        feet[id] = [x, y, z, 1, n % 1, z - WR];
      });

      Y.Natural.placeFeet(st, feet);

      /* Les roues tournent avec ce que le pneu parcourt : un shuffle sur
         roues, c'est un pneu qui glisse ET une roue qui roule, et une roue
         figée pendant un dérapage se voit tout de suite. */
      if (S.wheels) {
        Y.LEGS.forEach(function (L) {
          const nd = Y.Robot.legs[L.id];
          if (!nd.wheel) return;
          const px = S.last[L.id];
          if (px !== undefined) nd.wheel.rotation.y -= (feet[L.id][0] - px) / 0.075;
          S.last[L.id] = feet[L.id][0];
        });
      }

      S.say = up > 0 ? "Shuffle · détente" : "Shuffle · appui";
    }
  };
})(window.YLO);
