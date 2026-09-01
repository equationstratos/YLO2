/* =====================================================================
   YLO-2 — le Shuffle

   Un running man de quadrupède : le robot glisse, ramasse une patte sous
   lui, saute pour intervertir ses diagonales en l'air, retombe amorti et
   contre-glisse. C'est un GÉNÉRATEUR DE TRAJECTOIRES DE PIEDS et non une
   suite de consignes de marche : le générateur d'allure sait faire avancer
   un robot, il ne sait pas le faire danser, parce qu'une allure cherche
   justement à ne PAS glisser.

   Le cycle tient en quatre temps, et il est écrit tel quel dans le code :

     1  GLISSE      la diagonale d'appui recule au sol, pied collé ;
                    la patte avant opposée gratte vers le bas et l'arrière ;
                    la dernière se replie sous le centre de masse.
     2  SAUT        impulsion sur la diagonale d'appui, la caisse décolle ;
                    en l'air, les diagonales s'échangent — la repliée se
                    détend vers l'avant, l'ancienne d'appui se lève.
     3  RÉCEPTION   la nouvelle diagonale touche, genoux fléchis pour
                    absorber, puis rétro-pulsion : c'est ce recul des pieds
                    au sol qui fait lire le pas comme un shuffle.
     4  RESET       roulis et tangage marqués au tempo, et l'on recommence
                    sur l'autre diagonale.

   Sur ROUES, la même chorégraphie tient : le pneu remplace le pied, la
   griffe devient un dérapage et le saut reste un saut. C'est même plus
   juste — une roue qui glisse ne triche pas, alors qu'un pied qui glisse
   devrait s'user.

   Le centre de masse reste dans le polygone d'appui pendant les temps 1, 3
   et 4 : la diagonale au sol passe par-dessous, et le report de caisse est
   décalé vers elle. Au temps 2 il n'y a plus d'appui du tout — c'est un
   saut, la question ne se pose que de part et d'autre.
   ===================================================================== */
(function (Y) {
  "use strict";

  const K = Y.K;

  /* Tempo. 0,46 s le cycle de quatre temps, soit 130 à la noire : c'est le
     rythme d'un running man, deux fois plus vif qu'une marche. */
  const CYCLE = 0.46;
  const CYCLES = 14;                 // durée du pas : un peu plus de six secondes

  /* Les amplitudes. Elles sont en mètres et en radians, et elles sont
     petites : une danse de robot se lit au RYTHME, pas à l'amplitude, et
     tout ce qui dépasse l'enveloppe de travail se fait écrêter de toute
     façon — autant rester dedans. */
  const SLIDE = 0.085;               // course du glissement, avant → arrière
  const SCRAPE = 0.055;              // profondeur de la griffe
  const CHAMBER = 0.075;             // repli du pied sous la caisse
  const HOP = 0.038;                 // détente de la caisse au saut
  const CLEAR = 0.055;               // garde au sol d'un pied en l'air
  const SQUAT = 0.028;               // flexion d'amorti à la réception
  const ROLL = 0.085;                // roulis marqué au tempo
  const PITCH = 0.055;               // tangage
  const WAG = 0.10;                  // lacet de caisse, le déhanché
  const DRIFT = 0.16;                // avancée par cycle : le « in » du shuffle

  /* Les deux diagonales, avec les identifiants du dépôt : `lf` avant-gauche,
     `rh` arrière-droit, et l'autre paire. */
  const DIAG = [["lf", "rh"], ["rf", "lh"]];

  const S = {
    on: false, t: 0, say: "", beat: 0, cyc: 0, adv: 0,
    back: null, modeFn: null, x0: 0, y0: 0, yaw0: 0, wheels: false, last: {}
  };

  function ease(u) { return u * u * (3 - 2 * u); }
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
      S.on = true; S.t = 0; S.cyc = 0; S.adv = 0; S.say = "Shuffle"; S.last = {};
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
      const u = (T % CYCLE) / CYCLE;              // 0 → 1 sur les quatre temps
      const d = cyc % 2;                          // diagonale d'appui du cycle
      const other = 1 - d;
      S.cyc = cyc;
      S.beat = Math.floor(u * 4) + 1;

      /* Fondu d'entrée et de sortie : le pas ne commence ni ne finit sur une
         amplitude pleine, sinon la première image est un à-coup. */
      const fade = Math.min(1, T / 0.30, (Y.Dance.duration - T) / 0.40);

      /* --- les quatre temps, en fractions du cycle --- */
      const b1 = u < 0.25, b2 = u >= 0.25 && u < 0.42;
      const b3 = u >= 0.42 && u < 0.70;
      const uu = b1 ? u / 0.25
        : b2 ? (u - 0.25) / 0.17
        : b3 ? (u - 0.42) / 0.28
        : (u - 0.70) / 0.30;

      /* --- caisse ---
         Elle décolle au temps 2 et s'écrase à la réception. Le roulis suit la
         diagonale d'appui — le poids passe d'un côté puis de l'autre —, et le
         tangage rebondit à deux fois le tempo : c'est lui qui donne le
         « bounce ». */
      const ride = lerp(0.235, S.back ? S.back.height : 0.25, 0.25);
      let lift = 0, squat = 0;
      if (b2) lift = Math.sin(uu * Math.PI) * HOP;
      if (b3) squat = Math.sin(uu * Math.PI) * SQUAT;
      const side = d === 0 ? 1 : -1;
      st.roll = lerp(st.roll, side * ROLL * fade, Math.min(1, dt * 18));
      st.pitch = lerp(st.pitch,
        (Math.sin(u * Math.PI * 4) * PITCH - (b3 ? uu * 0.03 : 0)) * fade,
        Math.min(1, dt * 18));
      st.yawWag = Math.sin(u * Math.PI * 2) * WAG * fade;
      st.sway = 0;

      /* --- déplacement ---
         Le shuffle « in » avance : le robot progresse d'un cran par cycle,
         posé sur la lancée de la rétro-pulsion. Et il tourne très peu — le
         lacet de caisse suffit à donner le déhanché sans le faire dériver. */
      /* L'avancée est CUMULÉE : elle ne se fond pas, sous peine de ramener
         le robot en arrière à la fin du pas — un fondu s'applique à une
         amplitude, jamais à une position déjà parcourue. */
      let adv = (cyc + ease(Math.min(1, u * 1.4))) * DRIFT;
      const wx = Math.cos(S.yaw0), wy = Math.sin(S.yaw0);
      /* Et l'on ne danse pas à travers un mur : la caisse a beau être posée
         image par image, elle reste soumise à ce qui l'entoure. */
      if (Y.Terrain && adv > S.adv) {
        const z = Y.Terrain.heightAt(st.px, st.py) + 0.25;
        if (Y.Terrain.blocked(st.px, st.py, z,
              S.x0 + wx * (adv + 0.35), S.y0 + wy * (adv + 0.35), z, 0.05)) {
          adv = S.adv;
        }
      }
      S.adv = adv;
      st.px = S.x0 + wx * adv;
      st.py = S.y0 + wy * adv;
      st.yaw = S.yaw0;

      const ground = Y.Terrain ? Y.Terrain.heightAt(st.px, st.py) : 0;
      /* Sur roues, la cinématique vise l'ESSIEU et non le contact : il est un
         rayon plus haut. Toute la chorégraphie s'écrit au niveau du contact,
         et ce décalage est ajouté à la fin — la danse n'a pas à savoir sur
         quoi le robot roule. */
      const WR = S.wheels ? 0.075 : 0;
      st.z = ground + ride + WR + (lift - squat) * fade;

      /* --- les pieds --- */
      const feet = {};
      Y.LEGS.forEach(function (L) {
        const id = L.id;
        const nx = L.x, ny = L.y + L.m * K.abadPlane;
        let x = nx, y = ny, z = -ride, contact = 1;

        const stance = inDiag(id, d);          // appui de ce cycle
        const front = L.f > 0;

        if (b1) {
          /* TEMPS 1 — la glisse.
             La diagonale d'appui recule sous le robot, pied au sol : c'est ce
             glissement-là qu'on voit. La patte avant de l'autre diagonale
             gratte vers le bas et l'arrière — l'appel du running man —, et la
             patte arrière se replie sous le centre de masse. */
          if (stance) {
            x = nx + lerp(SLIDE, -SLIDE, ease(uu));
          } else if (front) {
            x = nx + lerp(0.02, -SCRAPE * 1.4, ease(uu));
            z = -(ride) + Math.sin(uu * Math.PI) * SCRAPE * 0.35;
            contact = uu > 0.35 ? 1 : 0;
          } else {
            x = nx + lerp(-SLIDE * 0.6, CHAMBER * 0.4, ease(uu));
            y = ny * lerp(1, 0.72, ease(uu));
            z = -(ride) + lerp(0, CHAMBER, ease(uu));
            contact = 0;
          }
        } else if (b2) {
          /* TEMPS 2 — le saut, et l'échange.
             La diagonale d'appui se détend puis quitte le sol ; la repliée se
             lance vers l'avant. Personne ne touche au sommet : c'est ce vide
             qui autorise l'inversion, et c'est pour ça que le temps 2 est le
             plus court des quatre. */
          const air = Math.sin(uu * Math.PI);
          if (stance) {
            x = nx - SLIDE * (1 - uu * 0.4);
            z = -(ride) + air * CLEAR * 0.8;
            contact = uu < 0.25 ? 1 : 0;
          } else {
            x = nx + lerp(front ? -SCRAPE : CHAMBER * 0.4, SLIDE * 0.9, ease(uu));
            y = ny * lerp(front ? 1 : 0.72, 1, ease(uu));
            z = -(ride) + lerp(front ? 0 : CHAMBER, 0, ease(uu)) + air * CLEAR * 0.5;
            contact = 0;
          }
        } else if (b3) {
          /* TEMPS 3 — la réception et la contre-glisse.
             La NOUVELLE diagonale — celle du cycle suivant — prend le sol,
             genoux fléchis, puis recule : la rétro-pulsion. Les deux autres
             pattes finissent leur course en l'air et se posent en fin de
             temps. */
          const now = inDiag(id, other);
          if (now) {
            x = nx + lerp(SLIDE * 0.9, SLIDE * 0.15, ease(uu));
            contact = 1;
          } else {
            x = nx + lerp(-SLIDE, 0, ease(uu));
            z = -(ride) + (1 - ease(uu)) * CLEAR * 0.6;
            contact = uu > 0.7 ? 1 : 0;
          }
        } else {
          /* TEMPS 4 — le reset.
             Tout est au sol, la caisse marque le tempo, et les pieds
             reviennent à la position d'où la glisse du cycle suivant
             repartira. C'est le temps qui rend le pas BOUCLABLE : sans lui,
             la reprise se ferait sur une discontinuité. */
          const nextStance = inDiag(id, other);
          x = nx + lerp(nextStance ? SLIDE * 0.15 : 0, nextStance ? SLIDE : -SLIDE * 0.6,
                        ease(uu));
          contact = 1;
        }

        /* Le report de caisse : les pieds d'appui passent LÉGÈREMENT sous le
           robot du côté chargé. C'est ce qui garde le centre de masse dans le
           polygone au lieu de le laisser au bord. */
        y -= side * 0.012 * fade * (contact ? 1 : 0);

        // amplitude fondue au départ et à l'arrivée
        x = nx + (x - nx) * fade;
        y = ny + (y - ny) * fade;
        z = -(ride) + (z + ride) * fade - (squat) * 0.4 * fade;

        feet[id] = [x, y, z, contact, u, z - WR];
      });

      Y.Natural.placeFeet(st, feet);

      /* Les roues tournent avec ce que le pneu parcourt : un shuffle sur
         roues, c'est un pied qui glisse ET une roue qui roule, et une roue
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
      S.say = ["Glisse", "Saut", "Réception", "Reset"][
        Math.min(3, Math.floor(u * 4))];
    }
  };
})(window.YLO);
