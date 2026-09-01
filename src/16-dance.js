/* =====================================================================
   YLO-2 — le Shuffle

   Le pas de danse sur place des quadrupèdes de Boston Dynamics, relevé
   IMAGE PAR IMAGE sur une séquence de référence plutôt que deviné. Trois
   versions ont été nécessaires, et chacune ratait pour une raison qu'on ne
   voit qu'en mesurant.

   Ce que la séquence dit, une fois les pieds isolés du fond :

     · le PIED DÉCOLLE, et haut. Les deux pieds d'une diagonale montent à
       près de 200 mm — un tiers de la hauteur au garrot — pendant que
       l'autre diagonale reste plantée. Une version précédente gardait les
       quatre pieds collés au sol « pour ne pas rompre le contact » : le
       robot avait l'air de piétiner, pas de danser. C'est le décollage
       franc qui fait tout, et il ne rompt rien puisque l'autre diagonale
       porte.
     · le REBOND bat toutes les 480 ms — 125 à la minute —, et son amplitude
       vaut 28 % de la hauteur au garrot. Ramenée aux 235 mm de garde
       d'YLO-2, cela fait 66 mm de battement.
     · l'ASSIETTE bascule de 16° d'un bord à l'autre, à la moitié de la
       fréquence du rebond : un pas nez haut, le suivant nez bas.

   C'est donc un TROT SUR PLACE, très haut sur pattes et très rebondi : la
   diagonale d'appui racle vers l'arrière pendant que l'autre est jetée vers
   l'avant, genoux hauts. Il ne reste du « shuffle » que le raclement des
   pieds portants — et c'est très bien ainsi, c'est lui qui distingue le pas
   d'un simple trot.

   Le tout se danse dans le train où l'on est : sur pattes le pied racle, sur
   roues le pneu dérape. C'est même plus juste sur roues — une roue qui
   glisse ne triche pas.
   ===================================================================== */
(function (Y) {
  "use strict";

  const K = Y.K;

  /* Un pas. Mesuré à 480 ms sur la séquence de référence. */
  const STEP = 0.48;
  const STEPS = 14;                  // un peu moins de sept secondes de pas

  /* Amplitudes, en mètres et en radians. Le rebond, le décollage et
     l'assiette sont relevés ; le reste les accompagne. */
  /* Le robot danse HAUT sur pattes. Sur la séquence, il se tient nettement
     plus haut qu'au repos : c'est ce qui laisse la place au pied de monter et
     ce qui donne au pas son air ressort. 260 mm sur les 420 de portée. */
  const RIDE = 0.260;                // garde moyenne pendant la danse
  const BOUNCE = 0.033;              // demi-battement : 66 mm bout à bout
  const LIFT = 0.088;                // décollage du pied — un tiers de la garde
  const SWING = 0.070;               // demi-course avant/arrière du pied jeté
  const SCUFF = 0.045;               // recul du pied portant : le raclement
  const PITCH = 0.14;                // assiette : 16° bout à bout
  const ROLL = 0.035;                // roulis du report de poids
  const WAG = 0.045;                 // lacet de caisse
  /* Le vol occupe un peu plus de la moitié du pas : c'est ce recouvrement
     qui garantit qu'au moins deux pieds portent en permanence. */
  const FLY0 = 0.06, FLY1 = 0.62;

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
    duration: STEP * STEPS,

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
      const n = T / STEP;                        // pas écoulés, en continu
      const k = Math.floor(n);                   // le pas en cours
      const u = n - k;                           // 0 → 1 dans le pas
      const fly = k % 2;                         // la diagonale qui est en l'air
      S.cyc = k; S.beat = fly + 1;

      /* Fondu d'entrée et de sortie : le pas ne commence ni ne finit sur une
         amplitude pleine, sinon la première image est un à-coup. */
      const fade = Math.min(1, T / 0.35, (Y.Dance.duration - T) / 0.40);

      /* Sur place, strictement : le cap et la position ne bougent pas. */
      st.px = S.x0; st.py = S.y0; st.yaw = S.yaw0;
      const ground = Y.Terrain ? Y.Terrain.heightAt(st.px, st.py) : 0;
      const WR = S.wheels ? 0.075 : 0;

      /* Le rebond : la caisse est BASSE au poser — quand les quatre pieds
         sont au sol et que le poids arrive — et haute au milieu du vol. Un
         rebond par pas, comme mesuré. */
      const up = -Math.cos(u * Math.PI * 2);
      const ride = RIDE + up * BOUNCE * fade;
      st.z = ground + ride + WR;

      /* L'assiette bascule à la MOITIÉ de la fréquence du pas : un pas nez
         haut, le suivant nez bas. Le roulis suit la diagonale portante. */
      const w = n * Math.PI * 2;
      st.pitch = lerp(st.pitch, Math.sin(w / 2) * PITCH * fade, Math.min(1, dt * 20));
      st.roll = lerp(st.roll, (fly === 0 ? 1 : -1) * ROLL * fade, Math.min(1, dt * 12));
      st.yawWag = Math.sin(w / 2 + 0.8) * WAG * fade;
      st.sway = 0;

      /* --- les appuis ---
         La diagonale en vol part vers l'arrière, monte haut, et se pose
         devant. Celle qui porte fait l'inverse au sol, lentement : c'est le
         RACLEMENT, et c'est lui qui reste du shuffle. */
      const feet = {};
      Y.LEGS.forEach(function (L) {
        const id = L.id;
        const nx = L.x, ny = L.y + L.m * K.abadPlane;
        const airborne = DIAG[fly][0] === id || DIAG[fly][1] === id;

        let x, z = -ride, contact = 1;
        if (airborne && u > FLY0 && u < FLY1) {
          /* EN VOL. Le pied quitte le sol vers l'arrière, passe haut sous la
             caisse — genou relevé —, et se repose devant. La trajectoire est
             une arche : montée et descente en sinus, avance en fondu. */
          const v = (u - FLY0) / (FLY1 - FLY0);
          x = nx + lerp(-SWING, SWING, ease(v));
          z = -ride + Math.sin(v * Math.PI) * LIFT;
          contact = 0;
        } else if (airborne) {
          /* Au sol, mais brièvement : juste avant de partir et juste après
             s'être posé. On tient la position d'extrémité. */
          x = nx + (u <= FLY0 ? -SWING : SWING);
        } else {
          /* PORTANTE : elle racle vers l'arrière sur toute la durée du pas.
             Elle part de là où elle s'est posée et recule sous la caisse. */
          x = nx + lerp(SWING * 0.55, SWING * 0.55 - SCUFF, ease(u));
        }

        const xf = nx + (x - nx) * fade;
        const zf = -ride + (z + ride) * fade;
        feet[id] = [xf, ny, zf, contact, u, zf - WR];
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

      S.say = fly === 0 ? "Shuffle · diagonale gauche" : "Shuffle · diagonale droite";
    }
  };
})(window.YLO);
