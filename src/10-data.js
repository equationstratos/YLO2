/* =====================================================================
   YLO-2 — données machine
   Cotes, chaîne articulaire, allures, sous-systèmes et groupes de
   matières. Tout vient du dépôt elpimous/ylo-2 (voir README).
   Repère URDF : X avant, Y gauche, Z haut.
   ===================================================================== */
window.YLO = window.YLO || {};

(function (Y) {
  "use strict";

  Y.K = {
    trunkL: 0.569125, trunkW: 0.350, trunkH: 0.148521,
    // Dessus de caisse, relevé sur le maillage du tronc : c'est le plan sur
    // lequel se visse l'embase du lidar. Le prendre à trunkH/2 le plantait
    // dans le pont — le maillage n'est pas centré sur son milieu.
    trunkTop: 0.125,
    legX: 0.387 / 2 - 0.019,      // ±0.1745 m, entraxe HAA avant/arrière
    legY: 0.1144 / 2 + 0.006,     // ±0.0632 m, entraxe HAA gauche/droite
    legZ: 0.023,                  // décalage vertical tronc -> axe HAA
    abad: 0.092,                  // décalage latéral HAA -> HFE
    abadPlane: 0.091,             // + décalage y du joint KFE (-1 mm) : plan de la patte
    L1: 0.215427,                 // cuisse, axe HFE -> axe KFE
    L2: 0.229819,                 // jambe, axe KFE -> contact sol
    footR: 0.0265,
    haaMin: -70 * Math.PI / 180, haaMax: 70 * Math.PI / 180,
    kfeMin: -159 * Math.PI / 180, kfeMax: -37 * Math.PI / 180,
    tauMax: 15, velMax: 20,
    mass: { trunk: 3.128, hip: 0.599, upper: 1.080, lower: 0.175, foot: 0.078 }
  };
  Y.K.total = Y.K.mass.trunk +
    4 * (Y.K.mass.hip + Y.K.mass.upper + Y.K.mass.lower + Y.K.mass.foot);

  // mirror : +1 à gauche. front : +1 à l'avant. Les drapeaux dae reprennent
  // ceux du xacro (orientation des maillages d'origine).
  Y.LEGS = [
    { id: "lf", label: "LF", m: +1, f: +1, x: +Y.K.legX, y: +Y.K.legY, mdae: true,  fdae: true },
    { id: "rf", label: "RF", m: -1, f: +1, x: +Y.K.legX, y: -Y.K.legY, mdae: false, fdae: true },
    { id: "lh", label: "LH", m: +1, f: -1, x: -Y.K.legX, y: +Y.K.legY, mdae: true,  fdae: false },
    { id: "rh", label: "RH", m: -1, f: -1, x: -Y.K.legX, y: -Y.K.legY, mdae: false, fdae: false }
  ];

  Y.JOINTS = [];                                  // 12 axes, ordre du driver
  Y.LEGS.forEach(function (L) {
    ["haa", "hfe", "kfe"].forEach(function (j) { Y.JOINTS.push(L.id + "_" + j); });
  });

  // Répartition des 12 moteus sur les 4 ports CAN-FD de la PCAN-M.2
  Y.CANMAP = {};
  Y.LEGS.forEach(function (L, i) {
    ["haa", "hfe", "kfe"].forEach(function (j, k) {
      Y.CANMAP[L.id + "_" + j] = { port: i + 1, id: k + 1 };
    });
  });

  Y.GAITS = {
    stand: { label: "Statique", duty: 1, stance: 1, off: { lf: 0, rf: 0, lh: 0, rh: 0 } },
    walk:  { label: "Walk",  duty: 0.75, stance: 0.35, off: { lf: 0, rh: 0.25, rf: 0.5, lh: 0.75 } },
    trot:  { label: "Trot",  duty: 0.50, stance: 0.25, off: { lf: 0, rf: 0.5, lh: 0.5, rh: 0 } },
    pace:  { label: "Pace",  duty: 0.50, stance: 0.25, off: { lf: 0, lh: 0, rf: 0.5, rh: 0.5 } },
    bound: { label: "Bound", duty: 0.50, stance: 0.20, off: { lf: 0, rf: 0, lh: 0.5, rh: 0.5 } },
    // allures rapides : le rapport d'appui descend sous 0,5, il y a donc des
    // instants sans aucun appui — c'est ce qui fait la suspension d'un galop
    canter: { label: "Canter", duty: 0.42, stance: 0.16,
      off: { rh: 0, lh: 0.30, rf: 0.35, lf: 0.65 } },
    gallop: { label: "Galop", duty: 0.34, stance: 0.12,
      off: { lh: 0, rh: 0.12, rf: 0.52, lf: 0.64 } }
  };

  /* Vitesses de référence par allure (m/s) : cadence et amplitude de pas en
     découlent. Ordres de grandeur calés sur les quadrupèdes du commerce —
     Unitree Go2 annonce 3,7 m/s, le B2 6 m/s ; YLO-2 est plus petit et ses
     qdd100 sont donnés à 20 rad/s, d'où une plage utile plus basse. */
  Y.SPEED = {
    stand: 0.0, walk: 0.15, trot: 0.50, canter: 1.10, gallop: 1.70,
    pace: 0.45, bound: 0.90,
    max: 2.0,                 // butée du curseur, en marche
    wheelMax: 3.0,            // en roues : le Go2-W roule à 2,5 m/s
    declared: 1.7             // au-delà, les 20 rad/s de l'URDF sont dépassés
  };

  /* --- groupes de matières, éditables depuis l'interface ---

     Les couleurs par défaut sont celles du VRAI robot, relevées dans les
     textures des maillages du dépôt amont (les `*color.png` des dossiers
     `textured` de `champ_for_ylo2/ylo2_description`) plutôt qu'à l'œil : carénages orange
     #fc9000 à 99 % de `covers.png`, corps et jambes noirs (#000 à #181818),
     moteurs mjbots blancs à 55 % de `abadcolor.png`, pieds silicone gris-bleu
     #909c9c. C'est la livrée officielle, pas une interprétation. */
  Y.MATGROUPS = [
    { id: "cover",   name: "Carénages",     preset: { color: "#fc9000", metal: 0.10, rough: 0.30, pattern: "none" } },
    { id: "frame",   name: "Châssis",       preset: { color: "#0d0e0e", metal: 0.20, rough: 0.78, pattern: "print" } },
    { id: "abad",    name: "Moteurs ABAD",  preset: { color: "#f1f2f0", metal: 0.55, rough: 0.32, pattern: "brushed" } },
    { id: "hip",     name: "Hanches",       preset: { color: "#1b1c1c", metal: 0.50, rough: 0.42, pattern: "brushed" } },
    { id: "upper",   name: "Cuisses",       preset: { color: "#1b1c1c", metal: 0.50, rough: 0.42, pattern: "brushed" } },
    { id: "lower",   name: "Jambes",        preset: { color: "#1b1c1c", metal: 0.45, rough: 0.46, pattern: "brushed" } },
    { id: "foot",    name: "Pieds silicone", preset: { color: "#909c9c", metal: 0.00, rough: 0.85, pattern: "none" } },
    { id: "sensor",  name: "Capteurs",      preset: { color: "#2b3134", metal: 0.45, rough: 0.38, pattern: "none" } },
    { id: "battery", name: "Batterie",      preset: { color: "#1d232a", metal: 0.25, rough: 0.70, pattern: "none" } },
    { id: "board",   name: "Électronique",  preset: { color: "#1c6b48", metal: 0.20, rough: 0.60, pattern: "none" } },
    { id: "wheel",   name: "Pneus",         preset: { color: "#15181a", metal: 0.10, rough: 0.85, pattern: "none" } },
    { id: "rim",     name: "Jantes",        preset: { color: "#fc9000", metal: 0.35, rough: 0.34, pattern: "brushed" } },
    { id: "hub",     name: "Moyeux",        preset: { color: "#0d0e0e", metal: 0.55, rough: 0.40, pattern: "none" } },
    { id: "obstacle", name: "Obstacles",    preset: { color: "#5a6360", metal: 0.05, rough: 0.92, pattern: "print" } },
    { id: "obstacleEdge", name: "Nez de marche", preset: { color: "#ffc24d", metal: 0.10, rough: 0.65, pattern: "none" } }
  ];

  Y.PATTERNS = [
    { id: "none",    name: "Lisse" },
    { id: "brushed", name: "Alu brossé" },
    { id: "carbon",  name: "Carbone" },
    { id: "print",   name: "Impression 3D" },
    { id: "anodized", name: "Anodisé" },
    { id: "hex",     name: "Nid d'abeille" },
    { id: "perf",    name: "Tôle perforée" },
    { id: "stripe",  name: "Bandes d'atelier" }
  ];

  Y.THEMES = [
    { id: "officiel", name: "Officiel", set: { cover: "#fc9000", frame: "#0d0e0e", foot: "#909c9c", rim: "#fc9000", hub: "#0d0e0e" },
      pat: { cover: "none", frame: "print" } },
    { id: "atelier", name: "Atelier", set: { cover: "#d9dcd4", frame: "#3c443e", foot: "#ff6a2b" } },
    { id: "carbone", name: "Carbone", set: { cover: "#1b1e20", frame: "#16181a", foot: "#e8e8e8" },
      pat: { cover: "carbon", frame: "carbon" } },
    { id: "chantier", name: "Chantier", set: { cover: "#ffb400", frame: "#2a2a28", foot: "#141414" },
      pat: { cover: "stripe", frame: "print" } },
    { id: "labo", name: "Labo", set: { cover: "#f2f4f2", frame: "#c9cec9", foot: "#3aa0ff" },
      pat: { cover: "none", frame: "brushed" } },
    { id: "nuit", name: "Nuit", set: { cover: "#20262b", frame: "#171c20", foot: "#77c2a6" },
      pat: { cover: "anodized", frame: "hex" } }
  ];

  /* --- sous-systèmes : fiches reliées aux fichiers du dépôt --- */
  Y.SYS = [
    { id: "frame", group: "Structure", name: "Châssis imprimé + tubes carbone", qty: "3D + Ø1 mm",
      at: [0, 0, 0.02],
      desc: "Structure entièrement conçue de zéro : pièces imprimées 3D reliées par des tubes carbone de 1 mm d'épaisseur. Le tronc mesure 569 × 350 × 149 mm pour 3,128 kg déclarés dans l'URDF.",
      specs: [["Longueur", "569,1 mm"], ["Largeur", "350,0 mm"], ["Hauteur", "148,5 mm"], ["Masse tronc", "3,128 kg"], ["Masse totale", "10,86 kg"]],
      path: "champ_for_ylo2/ylo2_description/urdfs/const.xacro" },

    { id: "cover", group: "Structure", name: "Carénages peints 2K", qty: "×4",
      at: [0.12, 0, 0.085],
      desc: "Tous les capots sont imprimés 3D, poncés, peints puis vernis avec un vernis 2K. Ils ferment le volume électronique sans participer à la rigidité.",
      specs: [["Maillage", "ylo2_textured_cover.dae"], ["Procédé", "FDM + apprêt"], ["Finition", "vernis 2K"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_textured_cover.dae" },

    { id: "legs", group: "Structure", name: "Jambes CNC alu 7075", qty: "×4",
      at: [0.1745, 0.155, -0.12],
      desc: "Cuisses et jambes usinées CNC dans de l'aluminium 7075. La cuisse fait 215,4 mm d'axe HFE à axe KFE, la jambe 229,8 mm d'axe KFE au contact sol.",
      specs: [["Matière", "ALU 7075"], ["Cuisse L1", "215,4 mm"], ["Jambe L2", "229,8 mm"], ["Masse cuisse", "1,080 kg"], ["Masse jambe", "0,175 kg"]],
      path: "champ_for_ylo2/ylo2_description/meshes/leg/textured/ylo2_textured_upper_leg.dae" },

    { id: "belt", group: "Structure", name: "Transmission courroie GT3", qty: "550 dents",
      at: [0.1745, 0.155, -0.11],
      desc: "Le genou est entraîné par une courroie crantée GT3 550 dents entre deux poulies alu CNC : rapport 3:1 au genou, en plus du 6:1 du réducteur moteur, soit 18:1 en sortie.",
      specs: [["Courroie", "GT3 · 550 dents"], ["Poulies", "alu CNC"], ["Rapport genou", "3 : 1"], ["Chaîne totale", "18 : 1"]],
      path: "images/robot/timing_belt_idea.png" },

    { id: "foot", group: "Structure", name: "Pieds silicone moulés", qty: "×4",
      at: [0.1745, 0.155, -0.24],
      desc: "Pieds coulés en silicone dans un moule imprimé 3D, insérés en force comme une chaussette : remplacement immédiat en cas d'usure. Le point de contact est l'origine du repère « foot ».",
      specs: [["Maillage", "fl_foot.dae"], ["Rayon collision", "26,5 mm"], ["Masse", "0,078 kg"], ["Montage", "insertion en force"]],
      path: "champ_for_ylo2/ylo2_description/meshes/leg/textured/fl_foot.dae" },

    { id: "motors", group: "Actionneurs", name: "mjbots qdd100 beta 2", qty: "×12",
      at: [0.1745, 0.0632, 0],
      desc: "Douze actionneurs BLDC quasi-direct-drive, trois par patte : abduction (HAA), hanche (HFE), genou (KFE). Réducteur planétaire 6:1 intégré, contrôleur moteus embarqué.",
      specs: [["Nombre", "12 (3 × 4 pattes)"], ["Réducteur", "6 : 1"], ["Couple max URDF", "15 N·m"], ["Vitesse max", "20 rad/s"], ["Course HAA", "±70°"], ["Course KFE", "−159° … −37°"]],
      path: "Mjbots/README.md", link: "https://github.com/elpimous/ylo-2/tree/main/Mjbots" },

    { id: "moteus", group: "Actionneurs", name: "Contrôleurs moteus r4-5", qty: "×12",
      at: [0.1745, 0.0632, 0.02],
      desc: "Chaque articulation est pilotée en mode position par un moteus r4-5 sur bus CAN-FD. La bibliothèque C++ maison encode les trames, envoie les consignes et lit position / vitesse / couple.",
      specs: [["Bus", "CAN-FD"], ["Mode", "position"], ["Répartition", "4 ports × 3 moteurs"], ["Outil", "ZeroPosition"]],
      path: "moteus_driver/src/YloTwoPcanToMoteus.cpp", link: "https://github.com/elpimous/ylo-2/tree/main/moteus_driver" },

    { id: "power", group: "Énergie", name: "Batterie + power dist r4-3b", qty: "1",
      at: [-0.08, 0, -0.02],
      desc: "Accumulateur logé sous le tronc, distribution mjbots power dist r4-3b, et un BEC Hyper HV GSR-6005MD qui sort 12 V à 5 A (7 A crête) pour l'électronique.",
      specs: [["Maillage", "battery.stl"], ["Distribution", "power dist r4-3b"], ["BEC", "GSR-6005MD"], ["Sortie", "12 V / 5 A"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/battery.stl" },

    { id: "upx", group: "Calcul", name: "UP Xtreme i7", qty: "1",
      at: [0.05, 0, 0.045],
      desc: "Calculateur embarqué sous Ubuntu avec noyau temps réel : c'est lui qui fait tourner ROS Noetic, le contrôleur CHAMP et le driver moteus.",
      specs: [["Carte", "UP Xtreme i7"], ["OS", "Ubuntu 18.04 / 20.04"], ["Noyau", "RT 5.5.143-rt64"], ["Middleware", "ROS Noetic"]],
      path: "UP-Xtreme/rt_5.5.143rt64_kernel", link: "https://github.com/elpimous/ylo-2/tree/main/UP-Xtreme" },

    { id: "peak", group: "Calcul", name: "PEAK PCAN-M.2 4 canaux", qty: "1",
      at: [0.05, 0.05, 0.062],
      desc: "Carte M.2 (PCIe) quatre ports CAN-FD : un port par patte, trois contrôleurs moteus par port. Le driver Linux PEAK 8.12 expose PCAN_PCIBUS1…4.",
      specs: [["Interface", "M.2 PCIe"], ["Ports", "4 × CAN-FD"], ["Répartition", "3 moteurs / port"], ["Driver", "PEAK 8.12.0"]],
      path: "Peak4can/ylo2_library", link: "https://github.com/elpimous/ylo-2/tree/main/Peak4can" },

    { id: "imu", group: "Perception", name: "myAHRS+ IMU", qty: "1",
      at: [0, 0, 0.058],
      desc: "Centrale inertielle 9 axes sur USB, lue par myahrs_driver côté ROS. Elle fournit l'attitude du tronc au contrôleur d'allure.",
      specs: [["Type", "AHRS 9 axes"], ["Liaison", "USB / ttyACM0"], ["Nœud ROS", "myahrs_driver"], ["État", "opérationnel"]],
      path: "Myahrs+/README.md", link: "https://github.com/elpimous/ylo-2/tree/main/Myahrs%2B" },

    { id: "lidar", group: "Perception", name: "RPLIDAR A2", qty: "1",
      at: [-0.02, 0, 0.125],
      desc: "Lidar 2D 360° monté sur le dessus du tronc, destiné au gmapping et à l'AMCL. Nœud rplidar_ros sur ttyUSB0. Le maillage vient des descriptions WoLF.",
      specs: [["Balayage", "360° · 2D"], ["Maillage", "Rp_lidar_A2.dae"], ["Nœud ROS", "rplidar_ros"], ["Port", "/dev/ttyUSB0"]],
      path: "Wolf_for_ylo2/wolf_descriptions/ylo2_description/meshes/body/textured/Rp_lidar_A2.dae" },

    { id: "d435", group: "Perception", name: "RealSense D435", qty: "1",
      at: [0.255, 0, 0.055],
      desc: "Caméra de profondeur en façade, prévue pour la détection d'obstacles et l'analyse du terrain.",
      specs: [["Type", "profondeur stéréo"], ["Maillage", "ylo2_d435_textured.dae"], ["Position", "face avant"], ["État", "en cours"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_d435_textured.dae" },

    { id: "t265", group: "Perception", name: "RealSense T265", qty: "1",
      at: [-0.29, 0, 0.01],
      desc: "Caméra de tracking pour l'odométrie visuelle-inertielle. Dans l'URDF elle est placée à l'arrière du tronc, maillage mis à l'échelle 1 × 1,06 × 1,04.",
      specs: [["Type", "tracking VIO"], ["Maillage", "ylo2_t265_textured.dae"], ["Échelle URDF", "1 · 1,06 · 1,04"], ["État", "en cours"]],
      path: "champ_for_ylo2/ylo2_description/meshes/body/textured/ylo2_t265_textured.dae" },

    { id: "mic", group: "Perception", name: "ReSpeaker Mic Array v2", qty: "4 micros",
      at: [0.10, 0, 0.10],
      desc: "Réseau de 4 microphones avec 12 LED RGB programmables et détection d'activité vocale. Les LED servent de retour d'état : ordres reçus, activité, humeur.",
      specs: [["Micros", "4"], ["LED", "12 RGB"], ["Fonctions", "VAD / DOA"], ["API", "pixel_ring"]],
      path: "Respeaker4mic/README.md" },

    { id: "srf10", group: "Perception", name: "Télémètres SRF10", qty: "×2",
      at: [0.285, 0.085, 0.005],
      desc: "Sonars I2C Devantech en façade, pour la détection rapprochée. L'I2C fonctionne sur l'UP Xtreme, l'intégration des capteurs reste à faire.",
      specs: [["Type", "sonar I2C"], ["Bus", "I2C UP Xtreme"], ["État", "à intégrer"]],
      path: "Devantech_SRF10/README.md" },

    { id: "wheels", group: "Actionneurs", name: "Roues motrices (option)", qty: "×4",
      at: [0.1745, 0.155, -0.20],
      desc: "Variante roues, dans l'esprit des Unitree Go2-W et B2-W : un moteur de roue par patte, l'axe remplace le pied. Le robot roule à plat et garde ses pattes pour franchir ce que la roue ne monte pas.",
      specs: [["Rayon", "75 mm"], ["Vitesse max", "3,0 m/s"], ["Marche roulable", "≈ 68 mm"],
        ["Franchissement", "patte levée, 0,34 s"], ["Figures", "cabrage, pirouette, saut, salto"],
        ["Référence", "Go2-W : 2,5 m/s"]],
      path: "src/44-locomotion.js" },

    { id: "champ", group: "Logiciel", name: "CHAMP · contrôleur d'allure", qty: "ROS Noetic", focus: "legs",
      at: [0, 0, -0.06],
      desc: "Le générateur d'allure CHAMP, adapté à YLO-2, calcule les trajectoires de pieds puis les angles articulaires envoyés aux moteus en mode position. Le simulateur Python du dossier sim/ rejoue la même logique hors ROS.",
      specs: [["Hauteur nominale", "0,250 m"], ["Garde au sol", "0,040 m"], ["Durée d'appui", "0,250 s"], ["Vx max", "0,200 m/s"], ["ωz max", "1,000 rad/s"], ["Genoux", "orientation « >> »"]],
      path: "champ_for_ylo2/ylo2_config/config/gait/gait.yaml", link: "https://github.com/elpimous/ylo-2/tree/main/champ_for_ylo2" },

    { id: "wolf", group: "Logiciel", name: "WoLF · pile whole-body", qty: "simulation", focus: "frame",
      at: [0, 0, 0.14],
      desc: "Descriptions et essais WoLF (Whole-body Locomotion Framework) pour YLO-2, utilisés en simulation avant portage sur la machine réelle.",
      specs: [["Rôle", "whole-body control"], ["Support", "simulation"], ["Base", "k3lso_moteus"]],
      path: "Wolf_for_ylo2/wolf_descriptions", link: "https://github.com/elpimous/ylo-2/tree/main/Wolf_for_ylo2" }
  ];
})(window.YLO);
