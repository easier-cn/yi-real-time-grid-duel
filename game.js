/* =========================================================
   弈 · 即时棋局 25×25
   25x25 core inside a 31x31 reserved canvas, five-unit squads, grass, walls,
   towers, lane minions, skills and frame-accurate combat.
   ========================================================= */

(() => {
  "use strict";

  const CONFIG = Object.freeze({
    SIZE: 31,                  // reserved design canvas
    CORE_SIZE: 25,             // the actual 25x25 battlefield
    CORE_OFFSET: 3,            // 3-cell reserve on every side
    TICK_MS: 100,              // 0.1s logic frame
    MOVE_STEP_TICKS: 5,        // 0.5s per cell
    MOVE_RECOVERY_TICKS: 4,    // 4-frame recovery after arriving
    ATTACK_INTERVAL_TICKS: 10, // 10 frames per basic attack
    HP: 15,
    DAMAGE: 3
  });

  const MINION_CONFIG = Object.freeze({
    HP: 3,
    DAMAGE: 1,
    MOVE_TICKS: 8,
    ATTACK_WINDUP: 3,
    ATTACK_BACKSWING: 12,
    ATTACK_INTERVAL: 15,
    DETECT_RANGE: 1,
    LEASH_RANGE: 2,
    MAX_COUNT: 120
  });

  const LANE_CONFIG = Object.freeze({
    COUNT: 3,
    WAVE_FRAMES: 200,
    MINIONS_PER_LANE: 3,
    SPAWN_GAP: 16
  });

  const TOWER_CONFIG = Object.freeze({
    HP: 45,
    RANGE: 3,
    ATTACK_INTERVAL: 10,
    MINION_DAMAGE: 1,
    HERO_DAMAGE: 2
  });

  const RESPAWN_CONFIG = Object.freeze({
    BASE_SECONDS: 8,
    EARLY_END_SECONDS: 20,
    EARLY_END_MINUTES: 4,
    MID_END_SECONDS: 46,
    MID_END_MINUTES: 20,
    HARD_END_SECONDS: 60,
    HARD_END_MINUTES: 35,
    EARLY_STEP_MINUTES: 0.5,
    EARLY_GROWTH: 1.11
  });

  const SKILL_LIBRARY = Object.freeze({
    blink: {
      id: "blink",
      name: "折跃",
      cooldown: 900,
      aimed: true
    },
    shock: {
      id: "shock",
      name: "震域",
      cooldown: 60,
      windup: 10,
      backswing: 3,
      damage: 8,
      aimed: true
    },
    empower: {
      id: "empower",
      name: "强化普攻",
      cooldown: 90,
      charges: 3
    },
    heal: {
      id: "heal",
      name: "复苏",
      cooldown: 900,
      instant: true
    }
  });

  const HERO_SKILL_KITS = Object.freeze({
    1: ["blink", "shock"],
    2: ["heal"],
    3: ["blink", "empower"],
    4: ["heal"],
    5: []
  });

  const DIRECTIONS_BY_KEY = {
    W: { dr: -1, dc: 0, label: "上" },
    A: { dr: 0, dc: -1, label: "左" },
    S: { dr: 1, dc: 0, label: "下" },
    D: { dr: 0, dc: 1, label: "右" }
  };

  const FOCUS_DIRECTIONS = {
    w: { dr: -1, dc: 0, label: "上" },
    a: { dr: 0, dc: -1, label: "左" },
    s: { dr: 1, dc: 0, label: "下" },
    d: { dr: 0, dc: 1, label: "右" }
  };

  const COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ".split("");
  const BOARD_MARGIN = 5;
  const BOARD_SPAN = 90;
  const CELL_SIZE = BOARD_SPAN / CONFIG.SIZE;
  const SAVE_KEY = "yi-board-design-v1";
  const SAVE_BACKUP_KEY = "yi-board-design-v1-backup";

  const TEAM_DEFS = {
    red: {
      id: "red",
      name: "赤方",
      short: "赤",
      en: "RED SQUAD",
      color: "#f06356",
      hi: "#ff9a89",
      deep: "#7f2325",
      rangeFill: "rgba(240, 99, 86, 0.12)",
      rangeLine: "rgba(240, 99, 86, 0.38)",
      rangeDot: "rgba(240, 99, 86, 0.58)",
      startCells: [
        { row: 25, col: 5 },
        { row: 24, col: 4 },
        { row: 24, col: 6 },
        { row: 26, col: 4 },
        { row: 26, col: 6 }
      ]
    },
    blue: {
      id: "blue",
      name: "蓝方",
      short: "蓝",
      en: "BLUE SQUAD",
      color: "#67adf5",
      hi: "#a6d3ff",
      deep: "#183e79",
      rangeFill: "rgba(103, 173, 245, 0.12)",
      rangeLine: "rgba(103, 173, 245, 0.38)",
      rangeDot: "rgba(103, 173, 245, 0.58)",
      startCells: [
        { row: 5, col: 25 },
        { row: 6, col: 24 },
        { row: 6, col: 26 },
        { row: 4, col: 24 },
        { row: 4, col: 26 }
      ]
    }
  };

  const UNITS = [];
  for (const teamId of ["red", "blue"]) {
    TEAM_DEFS[teamId].startCells.forEach((start, index) => {
      UNITS.push({
        id: `${teamId}-${index + 1}`,
        team: teamId,
        number: index + 1,
        name: `${TEAM_DEFS[teamId].short}${index + 1}`,
        start
      });
    });
  }
  const UNIT_IDS = UNITS.map((unit) => unit.id);

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DIRECTIONS = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1]
  ];

  // Visual motion is intentionally independent from the 0.1s logic clock.
  const MOVE_ANIM_MS = CONFIG.MOVE_STEP_TICKS * CONFIG.TICK_MS;
  const NORMAL_SIGMA = 0.18;
  const NORMAL_START = normalCdfRaw(0);
  const NORMAL_END = normalCdfRaw(1);
  const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // One primary step outweighs every possible secondary line-deviation.
  const PATH_STEP_COST = 1_000_000;
  const FIRST_HORIZONTAL_BIAS = 0.0001;

  const els = {};
  const pieceEls = {};
  const unitEls = {};
  const cellEls = [];
  const minionEls = {};
  const towerEls = {};
  const timers = new Set();

  let game;
  let activeMap;
  let draftMap;
  let grassPatches = new Map();
  let hoverCell = null;
  let toastTimer = null;
  let routeKey = "";
  let rangeKey = "";
  let skillKey = "";
  let lastFrame = 0;
  let accumulator = 0;
  let visualTime = 0;
  let paused = false;

  const editor = {
    active: false,
    tool: "board",
    towerTeam: "blue",
    heroSlot: 0,
    laneIndex: 0,
    laneDraft: null,
    hoverEdge: null,
    painting: false,
    savedPaused: false
  };

  let lockTeam = "blue";
  let viewTeam = "blue";
  let rallyArmed = false;
  let fogCells = [];
  let minimapCtx = null;
  let visionCacheTick = -1;
  let visionCacheTeam = "";
  let visionCacheHero = null;
  let visionCache = new Set();

  const focusState = {
    active: false,
    heroId: null,
    keys: new Set(),
    lastKey: null,
    lastDir: null,
    nextMoveTick: 0,
    queuedAttack: false
  };

  /* ---------------------------------------------------------
     Small math helpers and Gaussian easing
     --------------------------------------------------------- */

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function erfApprox(x) {
    const sign = x < 0 ? -1 : 1;
    const absolute = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1 / (1 + p * absolute);
    const y =
      1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
        Math.exp(-absolute * absolute);

    return sign * y;
  }

  function normalCdfRaw(t) {
    const z = (t - 0.5) / NORMAL_SIGMA;
    return 0.5 * (1 + erfApprox(z / Math.SQRT2));
  }

  function normalEase(t) {
    const clamped = clamp01(t);
    return clamp01((normalCdfRaw(clamped) - NORMAL_START) / (NORMAL_END - NORMAL_START));
  }

  function normalSpeed(t) {
    const z = (clamp01(t) - 0.5) / NORMAL_SIGMA;
    return Math.exp(-0.5 * z * z);
  }

  /* ---------------------------------------------------------
     Map model and terrain
     --------------------------------------------------------- */

  function cellKey(row, col) {
    return `${row},${col}`;
  }

  function parseCellKey(key) {
    const [row, col] = key.split(",").map(Number);
    return { row, col };
  }

  function wallKey(axis, row, col) {
    return `${axis}:${row}:${col}`;
  }

  function createEmptyMap() {
    return {
      cells: new Set(),
      grass: new Set(),
      walls: new Set(),
      towers: [],
      heroSpawns: {
        red: Array.from({ length: 5 }, () => null),
        blue: Array.from({ length: 5 }, () => null)
      },
      blueMinionSpawn: null,
      lanes: Array.from({ length: LANE_CONFIG.COUNT }, () => null)
    };
  }

  function expandLaneWaypoints(points) {
    const lane = [];
    if (!points || !points.length) return lane;
    lane.push({ row: points[0].row, col: points[0].col });

    for (let index = 1; index < points.length; index += 1) {
      let row = lane[lane.length - 1].row;
      let col = lane[lane.length - 1].col;
      const target = points[index];

      while (col !== target.col) {
        col += Math.sign(target.col - col);
        lane.push({ row, col });
      }
      while (row !== target.row) {
        row += Math.sign(target.row - row);
        lane.push({ row, col });
      }
    }

    return lane;
  }

  function createDefaultMap() {
    const map = createEmptyMap();
    const start = CONFIG.CORE_OFFSET;
    const end = start + CONFIG.CORE_SIZE;

    // The 25x25 core stays complete; corner adjustments expand outward
    // into the surrounding 31x31 reserve.
    for (let row = start; row < end; row += 1) {
      for (let col = start; col < end; col += 1) {
        map.cells.add(cellKey(row, col));
      }
    }

    [
      [start - 1, start - 1], [start - 1, start], [start, start - 1],
      [start - 1, end], [start - 1, end + 1], [start, end],
      [end, start - 1], [end + 1, start - 1], [end, start],
      [end, end - 1], [end, end], [end + 1, end]
    ].forEach(([row, col]) => {
      if (row >= 0 && row < CONFIG.SIZE && col >= 0 && col < CONFIG.SIZE) {
        map.cells.add(cellKey(row, col));
      }
    });

    [
      [14, 10], [14, 11], [15, 10], [15, 11], [16, 11],
      [10, 19], [10, 20], [11, 19], [11, 20], [12, 20],
      [20, 21], [21, 20], [21, 21], [22, 21]
    ].forEach(([row, col]) => {
      if (map.cells.has(cellKey(row, col))) map.grass.add(cellKey(row, col));
    });

    map.walls.add(wallKey("h", 13, 7));
    map.walls.add(wallKey("h", 13, 8));
    map.walls.add(wallKey("v", 12, 17));
    map.walls.add(wallKey("v", 13, 17));

    map.towers.push({ row: 8, col: 23, team: "blue" });
    map.towers.push({ row: 23, col: 6, team: "red" });
    map.heroSpawns.red = [
      { row: 25, col: 5 },
      { row: 24, col: 4 },
      { row: 24, col: 6 },
      { row: 26, col: 4 },
      { row: 26, col: 6 }
    ];
    map.heroSpawns.blue = [
      { row: 5, col: 25 },
      { row: 6, col: 24 },
      { row: 6, col: 26 },
      { row: 4, col: 24 },
      { row: 4, col: 26 }
    ];
    map.blueMinionSpawn = { row: 5, col: 26 };
    const blueStart = { row: 5, col: 26 };
    map.lanes = [
      {
        id: 0,
        cells: expandLaneWaypoints([
          blueStart,
          { row: 5, col: 4 },
          { row: 24, col: 4 }
        ])
      },
      {
        id: 1,
        cells: expandLaneWaypoints([
          blueStart,
          { row: 5, col: 16 },
          { row: 15, col: 16 },
          { row: 15, col: 6 },
          { row: 24, col: 6 }
        ])
      },
      {
        id: 2,
        cells: expandLaneWaypoints([
          blueStart,
          { row: 24, col: 26 },
          { row: 24, col: 8 }
        ])
      }
    ];
    return map;
  }

  function cloneMap(source) {
    return {
      cells: new Set(source.cells),
      grass: new Set(source.grass),
      walls: new Set(source.walls),
      towers: source.towers.map((tower) => ({ ...tower })),
      heroSpawns: {
        red: (source.heroSpawns?.red || []).map((cell) => cell ? { ...cell } : null),
        blue: (source.heroSpawns?.blue || []).map((cell) => cell ? { ...cell } : null)
      },
      blueMinionSpawn: source.blueMinionSpawn ? { ...source.blueMinionSpawn } : null,
      lanes: Array.from({ length: LANE_CONFIG.COUNT }, (_, index) => {
        const lane = source.lanes?.[index];
        if (!lane) return null;
        return {
          id: index,
          cells: lane.cells.map((cell) => ({ ...cell }))
        };
      })
    };
  }

  function serializeMap(map) {
    return JSON.stringify({
      version: 1,
      cells: [...map.cells],
      grass: [...map.grass],
      walls: [...map.walls],
      towers: map.towers.map((tower) => ({ ...tower })),
      heroSpawns: {
        red: map.heroSpawns.red.map((cell) => cell ? { ...cell } : null),
        blue: map.heroSpawns.blue.map((cell) => cell ? { ...cell } : null)
      },
      blueMinionSpawn: map.blueMinionSpawn ? { ...map.blueMinionSpawn } : null,
      lanes: map.lanes.map((lane) => lane ? {
        id: lane.id,
        cells: lane.cells.map((cell) => ({ ...cell }))
      } : null)
    });
  }

  function mapFromSavedObject(saved) {
    if (!saved || !Array.isArray(saved.cells) || !saved.cells.length) return null;

    const map = createEmptyMap();
    map.cells = new Set(saved.cells.filter((key) => typeof key === "string"));
    map.grass = new Set((saved.grass || []).filter((key) => map.cells.has(key)));
    map.walls = new Set(saved.walls || []);
    map.towers = Array.isArray(saved.towers)
      ? saved.towers.filter((tower) => tower && Number.isFinite(tower.row) && Number.isFinite(tower.col))
        .map((tower) => ({ row: tower.row, col: tower.col, team: tower.team === "red" ? "red" : "blue" }))
      : [];
    for (const team of ["red", "blue"]) {
      const source = saved.heroSpawns?.[team];
      map.heroSpawns[team] = Array.from({ length: 5 }, (_, index) => {
        const cell = Array.isArray(source) ? source[index] : null;
        return cell && Number.isFinite(cell.row) && Number.isFinite(cell.col)
          ? { row: cell.row, col: cell.col }
          : null;
      });
    }
    map.blueMinionSpawn = saved.blueMinionSpawn &&
      Number.isFinite(saved.blueMinionSpawn.row) && Number.isFinite(saved.blueMinionSpawn.col)
      ? { row: saved.blueMinionSpawn.row, col: saved.blueMinionSpawn.col }
      : null;
    map.lanes = Array.from({ length: LANE_CONFIG.COUNT }, (_, index) => {
      const lane = Array.isArray(saved.lanes) ? saved.lanes[index] : null;
      if (!lane || !Array.isArray(lane.cells) || lane.cells.length < 2) return null;
      return {
        id: index,
        cells: lane.cells
          .filter((cell) => cell && Number.isFinite(cell.row) && Number.isFinite(cell.col))
          .map((cell) => ({ row: cell.row, col: cell.col }))
      };
    }).map((lane) => lane && lane.cells.length >= 2 ? lane : null);
    pruneWalls(map);
    return map;
  }

  function loadSavedMap() {
    const read = (key) => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? mapFromSavedObject(JSON.parse(raw)) : null;
      } catch (error) {
        return null;
      }
    };
    return read(SAVE_KEY) || read(SAVE_BACKUP_KEY);
  }

  function currentMap() {
    return editor.active && draftMap ? draftMap : activeMap;
  }

  function isTile(row, col, map = currentMap()) {
    return Boolean(map && row >= 0 && row < CONFIG.SIZE && col >= 0 && col < CONFIG.SIZE && map.cells.has(cellKey(row, col)));
  }

  function isWallBetween(fromRow, fromCol, toRow, toCol, map = currentMap()) {
    if (!map) return false;
    if (toRow === fromRow - 1 && toCol === fromCol) {
      return map.walls.has(wallKey("h", fromRow, fromCol));
    }
    if (toRow === fromRow + 1 && toCol === fromCol) {
      return map.walls.has(wallKey("h", fromRow + 1, fromCol));
    }
    if (toCol === fromCol - 1 && toRow === fromRow) {
      return map.walls.has(wallKey("v", fromRow, fromCol));
    }
    if (toCol === fromCol + 1 && toRow === fromRow) {
      return map.walls.has(wallKey("v", fromRow, fromCol + 1));
    }
    return false;
  }

  function canStepBetween(fromRow, fromCol, toRow, toCol, map = currentMap()) {
    return (
      isTile(toRow, toCol, map) &&
      !isWallBetween(fromRow, fromCol, toRow, toCol, map)
    );
  }

  function rebuildGrassPatches(map = currentMap()) {
    grassPatches = new Map();
    if (!map) return;

    let nextPatch = 1;
    const visited = new Set();
    const neighbors = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1], [0, 1],
      [1, -1], [1, 0], [1, 1]
    ];

    for (const key of map.grass) {
      if (visited.has(key) || !map.cells.has(key)) continue;
      const patchId = nextPatch;
      nextPatch += 1;
      const queue = [key];
      visited.add(key);

      while (queue.length) {
        const current = queue.pop();
        grassPatches.set(current, patchId);
        const { row, col } = parseCellKey(current);

        for (const [dr, dc] of neighbors) {
          const nextKey = cellKey(row + dr, col + dc);
          if (visited.has(nextKey) || !map.grass.has(nextKey) || !map.cells.has(nextKey)) continue;
          visited.add(nextKey);
          queue.push(nextKey);
        }
      }
    }
  }

  function grassPatchAt(row, col, map = currentMap()) {
    if (!isTile(row, col, map)) return null;
    return grassPatches.get(cellKey(row, col)) || null;
  }

  function isSameGrassPatch(a, b) {
    const patch = grassPatchAt(a.row, a.col);
    return patch !== null && patch === grassPatchAt(b.row, b.col);
  }

  function pruneWalls(map) {
    for (const key of [...map.walls]) {
      const [axis, rowText, colText] = key.split(":");
      const row = Number(rowText);
      const col = Number(colText);
      const hasSide = axis === "h"
        ? map.cells.has(cellKey(row - 1, col)) || map.cells.has(cellKey(row, col))
        : map.cells.has(cellKey(row, col - 1)) || map.cells.has(cellKey(row, col));
      if (!hasSide) map.walls.delete(key);
    }
  }

  function towerAt(row, col) {
    return currentMap().towers.find((tower) => tower.row === row && tower.col === col) || null;
  }

  class MinHeap {
    constructor() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }

    push(item) {
      const items = this.items;
      items.push(item);
      let index = items.length - 1;

      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (items[parent].cost <= item.cost) break;
        items[index] = items[parent];
        index = parent;
      }
      items[index] = item;
    }

    pop() {
      const items = this.items;
      if (!items.length) return null;
      const root = items[0];
      const last = items.pop();

      if (items.length && last) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          if (left >= items.length) break;

          let child = left;
          if (right < items.length && items[right].cost < items[left].cost) {
            child = right;
          }
          if (items[child].cost >= last.cost) break;

          items[index] = items[child];
          index = child;
        }
        items[index] = last;
      }

      return root;
    }
  }

  /* ---------------------------------------------------------
     Boot and DOM
     --------------------------------------------------------- */

  function boot() {
    activeMap = loadSavedMap() || createDefaultMap();
    draftMap = cloneMap(activeMap);
    rebuildGrassPatches(activeMap);

    cacheElements();
    buildBoard();
    buildPieces();
    buildRosters();
    bindEvents();

    game = createGame();
    seedInitialLogs();
    syncAll(true);

    lastFrame = performance.now();
    requestAnimationFrame(loop);
  }

  function cacheElements() {
    const ids = [
      "board", "cellGrid", "axisTop", "axisBottom", "axisLeft", "axisRight",
      "rangeLayer", "pathLine", "pathDots", "destinationMarker", "pieceLayer",
      "fxLayer", "cursorMark", "coordTip", "gameClock", "instructionText",
      "instructionHint", "statSelected", "statSteps", "statEta", "selectedState",
      "selectedHp", "selectedDot", "stepOne", "stepTwo", "logList", "toast", "resultOverlay",
      "resultStone", "resultTitle", "resultDesc", "resultTime", "resultRemaining",
      "replayBtn", "restartBtn", "helpBtn", "helpDialog", "closeHelp",
      "understoodBtn", "aliveRed", "aliveBlue", "unitsRed", "unitsBlue",
      "teamRed", "teamBlue", "skillLayer", "skillDock", "skillOwner",
      "skillBtn1", "skillBtn2", "skill1Cd", "skill2Cd", "skill1Shade",
      "skill2Shade", "skillDpad", "skillDpadCenter", "skillHint",
      "grassLayer", "wallLayer", "wallGroup", "towerLayer", "minionLayer",
      "editorLayer", "laneLayer", "laneGroup", "editorBtn",
      "editorBar", "editorHint", "editorApply",
      "editorReset", "editorCancel", "editorSave", "coreFrame",
      "editorImport", "editorExport", "boardImportFile",
      "fogLayer", "targetMark", "focusFrame", "focusHud", "focusName",
      "focusTeam", "minimap"
    ];
    for (const id of ids) {
      els[id] = document.getElementById(id);
    }
  }

  function pos(index) {
    return BOARD_MARGIN + (index + 0.5) * CELL_SIZE;
  }

  function buildBoard() {
    els.cellGrid.replaceChildren();
    cellEls.length = 0;

    for (let row = 0; row < CONFIG.SIZE; row += 1) {
      const rowCells = [];
      for (let col = 0; col < CONFIG.SIZE; col += 1) {
        const cell = document.createElement("span");
        cell.className = "cell";
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        els.cellGrid.appendChild(cell);
        rowCells.push(cell);
      }
      cellEls.push(rowCells);
    }

    buildAxes();
    updateBoardCells(currentMap());
    renderMapLayers();
    buildFogLayer();
    if (els.minimap) minimapCtx = els.minimap.getContext("2d");
  }

  function buildFogLayer() {
    const fragment = document.createDocumentFragment();
    fogCells = [];
    for (let row = 0; row < CONFIG.SIZE; row += 1) {
      const rowCells = [];
      for (let col = 0; col < CONFIG.SIZE; col += 1) {
        const cell = document.createElement("span");
        cell.className = "fog-cell";
        fragment.appendChild(cell);
        rowCells.push(cell);
      }
      fogCells.push(rowCells);
    }
    els.fogLayer.replaceChildren(fragment);
  }

  function updateBoardCells(map = currentMap()) {
    if (!map) return;
    const editing = editor.active;
    els.board.classList.toggle("is-editing", editing);

    for (let row = 0; row < CONFIG.SIZE; row += 1) {
      for (let col = 0; col < CONFIG.SIZE; col += 1) {
        const cell = cellEls[row][col];
        if (!cell) continue;
        const tile = isTile(row, col, map);
        cell.classList.toggle("is-tile", tile);
        cell.classList.toggle("is-void", !tile);
        cell.classList.toggle("is-alt", tile && (row + col) % 2 === 1);
        cell.classList.toggle("edge-left", tile && !isTile(row, col - 1, map));
        cell.classList.toggle("edge-right", tile && !isTile(row, col + 1, map));
        cell.classList.toggle("edge-top", tile && !isTile(row - 1, col, map));
        cell.classList.toggle("edge-bottom", tile && !isTile(row + 1, col, map));
      }
    }

    if (els.coreFrame) {
      const left = BOARD_MARGIN + CONFIG.CORE_OFFSET * CELL_SIZE;
      const size = CONFIG.CORE_SIZE * CELL_SIZE;
      els.coreFrame.style.left = `${left}%`;
      els.coreFrame.style.top = `${left}%`;
      els.coreFrame.style.width = `${size}%`;
      els.coreFrame.style.height = `${size}%`;
    }
  }

  function renderMapLayers() {
    const map = currentMap();
    if (!map) return;
    rebuildGrassPatches(map);
    els.board.classList.toggle("is-editing", editor.active);

    const grass = document.createDocumentFragment();
    for (const key of map.grass) {
      if (!map.cells.has(key)) continue;
      const { row, col } = parseCellKey(key);
      const node = document.createElement("span");
      const patch = grassPatches.get(key) || 1;
      node.className = `grass-tile${patch % 2 === 0 ? " is-alt" : ""}`;
      node.style.left = `${pos(col)}%`;
      node.style.top = `${pos(row)}%`;
      grass.appendChild(node);
    }
    els.grassLayer.replaceChildren(grass);

    const walls = document.createDocumentFragment();
    for (const key of map.walls) {
      const [axis, rowText, colText] = key.split(":");
      const row = Number(rowText);
      const col = Number(colText);
      const line = document.createElementNS(SVG_NS, "line");
      if (axis === "h") {
        const y = BOARD_MARGIN + row * CELL_SIZE;
        line.setAttribute("x1", String(BOARD_MARGIN + col * CELL_SIZE));
        line.setAttribute("y1", String(y));
        line.setAttribute("x2", String(BOARD_MARGIN + (col + 1) * CELL_SIZE));
        line.setAttribute("y2", String(y));
      } else {
        const x = BOARD_MARGIN + col * CELL_SIZE;
        line.setAttribute("x1", String(x));
        line.setAttribute("y1", String(BOARD_MARGIN + row * CELL_SIZE));
        line.setAttribute("x2", String(x));
        line.setAttribute("y2", String(BOARD_MARGIN + (row + 1) * CELL_SIZE));
      }
      line.setAttribute("class", "wall-line");
      walls.appendChild(line);
    }

    if (
      editor.active &&
      editor.hoverEdge &&
      !map.walls.has(wallKey(editor.hoverEdge.axis, editor.hoverEdge.row, editor.hoverEdge.col))
    ) {
      const { axis, row, col } = editor.hoverEdge;
      const preview = document.createElementNS(SVG_NS, "line");
      if (axis === "h") {
        const y = BOARD_MARGIN + row * CELL_SIZE;
        preview.setAttribute("x1", String(BOARD_MARGIN + col * CELL_SIZE));
        preview.setAttribute("y1", String(y));
        preview.setAttribute("x2", String(BOARD_MARGIN + (col + 1) * CELL_SIZE));
        preview.setAttribute("y2", String(y));
      } else {
        const x = BOARD_MARGIN + col * CELL_SIZE;
        preview.setAttribute("x1", String(x));
        preview.setAttribute("y1", String(BOARD_MARGIN + row * CELL_SIZE));
        preview.setAttribute("x2", String(x));
        preview.setAttribute("y2", String(BOARD_MARGIN + (row + 1) * CELL_SIZE));
      }
      preview.setAttribute("class", "wall-line wall-line--preview");
      walls.appendChild(preview);
    }
    els.wallGroup.replaceChildren(walls);

    renderEditorLayer();
    renderLaneLayer();
  }

  function renderEditorLayer() {
    const map = currentMap();
    if (!map) return;
    const fragment = document.createDocumentFragment();

    if (editor.active) {
      for (const team of ["blue", "red"]) {
        const spawns = map.heroSpawns?.[team] || [];
        spawns.forEach((cell, index) => {
          if (!cell) return;
          fragment.appendChild(
            editorMarker(
              cell.row,
              cell.col,
              `hero hero--${team}`,
              String(index + 1),
              `${TEAM_DEFS[team].name} ${index + 1} 号英雄出生点`
            )
          );
        });
      }

      if (map.blueMinionSpawn) {
        fragment.appendChild(editorMarker(map.blueMinionSpawn.row, map.blueMinionSpawn.col, "minion-spawn", "兵", "蓝方小兵刷新点"));
      }

      for (const tower of map.towers) {
        fragment.appendChild(editorMarker(tower.row, tower.col, `tower tower--${tower.team}`, "塔", "防御塔"));
      }
    }

    els.editorLayer.replaceChildren(fragment);
  }

  function editorMarker(row, col, type, glyph, label) {
    const node = document.createElement("span");
    node.className = `editor-marker editor-marker--${type}`;
    node.style.left = `${pos(col)}%`;
    node.style.top = `${pos(row)}%`;
    node.title = label;
    node.textContent = glyph;
    return node;
  }

  function renderLaneLayer() {
    const map = currentMap();
    if (!map) return;
    const editing = editor.active;
    els.laneLayer.classList.toggle("is-visible", editing);
    if (!editing) {
      els.laneGroup.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    const addLane = (cells, laneId, isDraft = false) => {
      if (!cells || cells.length < 1) return;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        cells
          .map((cell, index) => `${index === 0 ? "M" : "L"} ${pos(cell.col)} ${pos(cell.row)}`)
          .join(" ")
      );
      path.setAttribute(
        "class",
        `lane-path lane-path--${laneId}${isDraft ? " is-draft" : ""}`
      );
      fragment.appendChild(path);

      cells.forEach((cell, index) => {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(pos(cell.col)));
        dot.setAttribute("cy", String(pos(cell.row)));
        dot.setAttribute(
          "r",
          index === 0 || index === cells.length - 1 ? "0.55" : "0.28"
        );
        dot.setAttribute(
          "class",
          `lane-dot lane-dot--${laneId}${index === 0 ? " is-start" : ""}${index === cells.length - 1 ? " is-end" : ""}`
        );
        fragment.appendChild(dot);
      });
    };

    map.lanes?.forEach((lane, index) => {
      if (!lane) return;
      addLane(lane.cells, index);
    });

    if (editor.laneDraft) {
      addLane(editor.laneDraft.cells, editor.laneDraft.laneIndex, true);
    }

    els.laneGroup.replaceChildren(fragment);
  }

  function buildAxes() {
    const top = document.createDocumentFragment();
    const bottom = document.createDocumentFragment();
    const left = document.createDocumentFragment();
    const right = document.createDocumentFragment();

    els.axisTop.replaceChildren();
    els.axisBottom.replaceChildren();
    els.axisLeft.replaceChildren();
    els.axisRight.replaceChildren();

    for (let i = 0; i < CONFIG.SIZE; i += 1) {
      const inCore = i >= CONFIG.CORE_OFFSET && i < CONFIG.CORE_OFFSET + CONFIG.CORE_SIZE;
      if (!inCore) continue;

      const coordinate = COLUMNS[i - CONFIG.CORE_OFFSET];

      const topLabel = document.createElement("span");
      topLabel.textContent = coordinate;
      topLabel.style.left = `${pos(i)}%`;
      topLabel.style.top = "2.45%";
      top.appendChild(topLabel);

      const bottomLabel = document.createElement("span");
      bottomLabel.textContent = coordinate;
      bottomLabel.style.left = `${pos(i)}%`;
      bottomLabel.style.top = "97.55%";
      bottom.appendChild(bottomLabel);

      const rowNumber = String(CONFIG.CORE_OFFSET + CONFIG.CORE_SIZE - i);
      const leftLabel = document.createElement("span");
      leftLabel.textContent = rowNumber;
      leftLabel.style.left = "2.45%";
      leftLabel.style.top = `${pos(i)}%`;
      left.appendChild(leftLabel);

      const rightLabel = document.createElement("span");
      rightLabel.textContent = rowNumber;
      rightLabel.style.left = "97.55%";
      rightLabel.style.top = `${pos(i)}%`;
      right.appendChild(rightLabel);
    }

    els.axisTop.appendChild(top);
    els.axisBottom.appendChild(bottom);
    els.axisLeft.appendChild(left);
    els.axisRight.appendChild(right);
  }

  function buildPieces() {
    const starts = heroStartCells();
    for (const def of UNITS) {
      const team = TEAM_DEFS[def.team];
      const start = starts[def.id] || def.start;
      const root = document.createElement("div");
      root.className = `piece piece--${def.team}${def.number === 1 ? " is-hero" : ""}`;
      root.dataset.unit = def.id;
      root.setAttribute("role", "img");
      root.innerHTML = `
        <span class="piece__halo"></span>
        <div class="piece__body">
          <div class="piece__stone">
            <span class="piece__glyph">${def.number}</span>
          </div>
        </div>
        <span class="piece__hp"><i class="piece__hp-fill"></i></span>
        <span class="piece__timer"></span>
        <span class="piece__eye" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>
      `;

      root.style.left = `${pos(start.col)}%`;
      root.style.top = `${pos(start.row)}%`;
      els.pieceLayer.appendChild(root);

      pieceEls[def.id] = {
        root,
        body: root.querySelector(".piece__body"),
        timer: root.querySelector(".piece__timer"),
        hpFill: root.querySelector(".piece__hp-fill"),
        eye: root.querySelector(".piece__eye")
      };
      root.setAttribute("aria-label", `${team.name} ${def.name}，位于 ${cellLabel(start.row, start.col)}，生命 ${CONFIG.HP} / ${CONFIG.HP}`);
    }
  }

  function buildRosters() {
    for (const teamId of ["red", "blue"]) {
      const container = teamId === "red" ? els.unitsRed : els.unitsBlue;

      for (const def of UNITS.filter((unit) => unit.team === teamId)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `unit-card${def.number === 1 ? " is-hero" : ""}`;
        button.dataset.unit = def.id;
        button.innerHTML = `
          <span class="unit-card__stone">${def.number}</span>
          <span class="unit-card__hp">${"<i></i>".repeat(CONFIG.HP)}</span>
          <span class="unit-card__state">待命</span>
        `;

        button.addEventListener("click", () => {
          if (!game || game.status !== "playing") return;
          const piece = game.pieces[def.id];
          if (piece && piece.hp > 0) selectUnit(piece);
        });

        container.appendChild(button);
        unitEls[def.id] = {
          root: button,
          pips: Array.from(button.querySelectorAll(".unit-card__hp i")),
          state: button.querySelector(".unit-card__state")
        };
      }
    }
  }

  function createTowerElement(tower) {
    const root = document.createElement("div");
    root.className = `tower tower--${tower.team}${tower.isCrystal ? " is-crystal" : ""}`;
    root.dataset.tower = tower.id;
    root.innerHTML = `
      <span class="tower__body">
        <span class="tower__base"></span>
        <span class="tower__core"></span>
        <span class="tower__crystal" aria-hidden="true">晶</span>
      </span>
      <span class="tower__hp"><i class="tower__hp-fill"></i></span>
      <span class="tower__eye" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>
    `;
    els.towerLayer.appendChild(root);
    towerEls[tower.id] = {
      root,
      body: root.querySelector(".tower__body"),
      hpFill: root.querySelector(".tower__hp-fill"),
      eye: root.querySelector(".tower__eye")
    };
    return towerEls[tower.id];
  }

  function createMinionElement(minion) {
    const root = document.createElement("div");
    root.className = `minion minion--${minion.team}`;
    root.dataset.minion = minion.id;
    root.innerHTML = `
      <span class="minion__body">
        <span class="minion__stone"></span>
      </span>
      <span class="minion__hp"><i class="minion__hp-fill"></i></span>
      <span class="minion__eye" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>
    `;
    els.minionLayer.appendChild(root);
    minionEls[minion.id] = {
      root,
      body: root.querySelector(".minion__body"),
      hpFill: root.querySelector(".minion__hp-fill"),
      eye: root.querySelector(".minion__eye")
    };
    return minionEls[minion.id];
  }

  function syncTowers() {
    if (!game) return;
    const live = new Set(game.towers.map((tower) => tower.id));

    for (const id of Object.keys(towerEls)) {
      if (!live.has(id)) {
        towerEls[id].root.remove();
        delete towerEls[id];
      }
    }

    for (const tower of game.towers) {
      const element = towerEls[tower.id] || createTowerElement(tower);
      element.root.style.left = `${pos(tower.col)}%`;
      element.root.style.top = `${pos(tower.row)}%`;
      element.root.classList.toggle("is-crystal", tower.isCrystal);
      element.root.classList.toggle("is-in-grass", isEntityInGrass(tower));
      element.root.classList.toggle("is-exposed", isEntityExposed(tower));
      element.root.setAttribute(
        "aria-label",
        `${TEAM_DEFS[tower.team].name}${tower.isCrystal ? "水晶" : "防御塔"}，位于 ${cellLabel(tower.row, tower.col)}，生命 ${tower.hp}/${tower.maxHp}`
      );
      element.hpFill.style.width = `${(tower.hp / tower.maxHp) * 100}%`;
      element.eye.classList.toggle("is-visible", isEntityExposed(tower));
    }
  }

  function syncMinions() {
    if (!game) return;
    const live = new Set(game.minions.map((minion) => minion.id));

    for (const id of Object.keys(minionEls)) {
      if (!live.has(id)) {
        minionEls[id].root.remove();
        delete minionEls[id];
      }
    }

    for (const minion of game.minions) {
      const element = minionEls[minion.id] || createMinionElement(minion);
      element.root.style.left = `${pos(minion.col)}%`;
      element.root.style.top = `${pos(minion.row)}%`;
      element.root.classList.toggle("is-fogged", !isEntityVisibleToViewTeam(minion));
      element.root.classList.toggle("is-in-grass", isEntityInGrass(minion));
      element.root.classList.toggle("is-exposed", isEntityExposed(minion));
      element.root.setAttribute(
        "aria-label",
        `${TEAM_DEFS[minion.team].name}小兵，位于 ${cellLabel(minion.row, minion.col)}，生命 ${minion.hp}/${minion.maxHp}`
      );
      element.hpFill.style.width = `${(minion.hp / minion.maxHp) * 100}%`;
      element.eye.classList.toggle("is-visible", isEntityExposed(minion));
    }
  }

  /* ---------------------------------------------------------
     Game state
     --------------------------------------------------------- */

  function createPiece(def, start = def.start) {
    const team = TEAM_DEFS[def.team];
    const isHero = def.number === 1;
    const kit = HERO_SKILL_KITS[def.number] || [];
    const skills = kit.length
      ? {
          1: { id: kit[0], cooldown: 0 },
          2: kit[1] ? { id: kit[1], cooldown: 0 } : null
        }
      : null;

    return {
      type: "hero",
      id: def.id,
      team: def.team,
      number: def.number,
      name: def.name,
      color: team.color,
      isHero,
      row: start.row,
      col: start.col,
      hp: CONFIG.HP,
      maxHp: CONFIG.HP,
      damage: def.number === 3 ? 2 : CONFIG.DAMAGE,
      state: "idle",              // idle | moving | recovering | attacking | casting | defeated
      path: [],
      destination: null,
      moveProgress: 0,
      recoveryTicks: 0,
      attackTarget: null,
      attackCharge: 0,
      attackResume: null,
      reroute: null,
      aiMove: false,
      anim: null,
      landedAt: null,
      revealedUntil: 0,
      eyesUntil: 0,
      skills,
      aim: null,
      cast: null,
      empowerCharges: 0,
      lastCommandTick: 0,
      respawnTicks: 0,
      respawnTotal: 0,
      manualTargetId: null,
      manualTargetLast: null,
      aiLaneMode: "assigned",
      queuedAttack: false,
      trackMove: false
    };
  }

  function createTowerEntity(spec, index) {
    const team = TEAM_DEFS[spec.team];
    return {
      type: "tower",
      id: `tower-${spec.team}-${index + 1}`,
      team: spec.team,
      name: `${team.short}塔${index + 1}`,
      color: team.color,
      row: spec.row,
      col: spec.col,
      hp: TOWER_CONFIG.HP,
      maxHp: TOWER_CONFIG.HP,
      damage: 0,
      state: "idle",
      attackTarget: null,
      attackCharge: 0,
      revealedUntil: 0,
      eyesUntil: 0,
      isCrystal: false,
      aim: null,
      cast: null
    };
  }

  function heroStartCells() {
    const used = new Set();
    const starts = {};
    const towerAtCell = (row, col) =>
      activeMap.towers.some((tower) => tower.row === row && tower.col === col);

    const isFree = (row, col) =>
      isTile(row, col, activeMap) && !used.has(cellKey(row, col)) && !towerAtCell(row, col);

    const takeNear = (row, col) => {
      if (isFree(row, col)) {
        used.add(cellKey(row, col));
        return { row, col };
      }

      for (let radius = 1; radius <= 8; radius += 1) {
        for (let dr = -radius; dr <= radius; dr += 1) {
          for (let dc = -radius; dc <= radius; dc += 1) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const nextRow = row + dr;
            const nextCol = col + dc;
            if (!isFree(nextRow, nextCol)) continue;
            used.add(cellKey(nextRow, nextCol));
            return { row: nextRow, col: nextCol };
          }
        }
      }

      return { row, col };
    };

    for (const def of UNITS) {
      const teamSpawns = activeMap.heroSpawns?.[def.team] || [];
      const preferred = teamSpawns[def.number - 1] || def.start;
      starts[def.id] = takeNear(preferred.row, preferred.col);
    }

    return starts;
  }

  function createGame() {
    const pieces = {};
    const teamIds = { red: [], blue: [] };
    const starts = heroStartCells();

    for (const def of UNITS) {
      pieces[def.id] = createPiece(def, starts[def.id]);
      teamIds[def.team].push(def.id);
    }

    const towers = activeMap.towers.map((spec, index) => createTowerEntity(spec, index));
    for (const team of ["red", "blue"]) {
      const spawn = activeMap.heroSpawns?.[team]?.[4];
      const candidates = towers.filter((tower) => tower.team === team);
      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        const da = spawn ? Math.abs(a.row - spawn.row) + Math.abs(a.col - spawn.col) : 0;
        const db = spawn ? Math.abs(b.row - spawn.row) + Math.abs(b.col - spawn.col) : 0;
        return da - db;
      });
      const crystal = candidates[0];
      crystal.isCrystal = true;
      crystal.name = `${TEAM_DEFS[team].short}方水晶`;
    }

    return {
      status: "playing",          // playing | over
      winner: null,               // red | blue | draw
      tick: 0,
      gameMs: 0,
      selected: null,
      hoverPlan: null,
      resultShown: false,
      logs: [],
      pieces,
      teamIds,
      towers,
      minions: [],
      nextMinionId: 1,
      nextWaveTick: LANE_CONFIG.WAVE_FRAMES,
      minionSpawnQueue: [],
      markedTargetId: null,
      rallyPoint: null,
      map: activeMap
    };
  }

  function seedInitialLogs() {
    addLog("提示", "system", "25×25 核心 + 31×31 预留 · 每子 15 HP · 普攻 3 伤害 / 10 帧。");
    addLog("系统", "system", "点击棋子，再点击空位；超过 30 帧无指令时英雄自动沿兵线行动。");
    addLog("系统", "system", "英雄阵亡会倒计时复活；摧毁对方水晶即获胜。");
  }

  function unitsOf(teamId) {
    return game.teamIds[teamId].map((id) => game.pieces[id]);
  }

  function allUnits() {
    return UNIT_IDS.map((id) => game.pieces[id]);
  }

  function allCombatants() {
    return [...allUnits(), ...game.towers, ...game.minions];
  }

  function findEntityById(id) {
    if (!id) return null;
    return game.pieces[id] || game.towers.find((tower) => tower.id === id) || game.minions.find((minion) => minion.id === id) || null;
  }

  function entityRoot(entity) {
    if (!entity) return null;
    if (entity.type === "tower") return towerEls[entity.id]?.root || null;
    if (entity.type === "minion") return minionEls[entity.id]?.root || null;
    return pieceEls[entity.id]?.root || null;
  }

  function entityBody(entity) {
    if (!entity) return null;
    if (entity.type === "tower") return towerEls[entity.id]?.body || null;
    if (entity.type === "minion") return minionEls[entity.id]?.body || null;
    return pieceEls[entity.id]?.body || null;
  }

  function livingUnits(teamId) {
    return unitsOf(teamId).filter((piece) => piece.hp > 0);
  }

  function selectedPiece() {
    return game.selected ? game.pieces[game.selected] : null;
  }

  function pieceAt(row, col) {
    for (const id of UNIT_IDS) {
      const piece = game.pieces[id];
      if (piece.hp > 0 && piece.row === row && piece.col === col) return piece;
    }
    return null;
  }

  function occupiersAt(row, col, ignoreId = null) {
    const found = [];
    for (const entity of allCombatants()) {
      if (entity.id === ignoreId) continue;
      if (entity.hp > 0 && entity.row === row && entity.col === col) found.push(entity);
    }
    return found;
  }

  function isOccupied(row, col, ignoreId = null, mover = null) {
    const occupants = occupiersAt(row, col, ignoreId);
    if (!occupants.length) return null;
    if (!mover) return occupants[0];

    for (const occupant of occupants) {
      if (mover.type === "minion") {
        continue;
      }
      if (mover.type === "hero" && occupant.type === "minion") {
        continue;
      }
      return occupant;
    }

    return null;
  }

  function inBounds(row, col) {
    return isTile(row, col);
  }

  function isEntityInGrass(entity) {
    return Boolean(entity && isTile(entity.row, entity.col) && grassPatchAt(entity.row, entity.col) !== null);
  }

  function revealEntity(entity, frames = 30) {
    if (!entity || !isEntityInGrass(entity)) return;
    entity.revealedUntil = Math.max(entity.revealedUntil || 0, game.tick + frames);
  }

  function isEntityVisibleTo(observer, target) {
    if (!observer || !target || target.hp <= 0) return false;
    if (observer.id === target.id) return true;
    if (target.type === "tower") return true;
    if (!isEntityInGrass(target)) return true;
    if ((target.revealedUntil || 0) > game.tick) return true;
    return isSameGrassPatch(observer, target);
  }

  function isEntityExposed(entity) {
    return Boolean(
      entity &&
      isEntityInGrass(entity) &&
      (entity.revealedUntil || 0) > game.tick
    );
  }

  function isFocusedHero(piece) {
    return Boolean(focusState.active && piece && focusState.heroId === piece.id);
  }

  function focusedHero() {
    if (!focusState.active || !game) return null;
    const piece = game.pieces[focusState.heroId];
    return piece && piece.hp > 0 ? piece : null;
  }

  function collectVision(team, focusHeroId = null) {
    const visible = new Set();
    if (!game) return visible;
    const addSquare = (row, col, radius) => {
      for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
          const rr = row + dr;
          const cc = col + dc;
          if (inBounds(rr, cc)) visible.add(cellKey(rr, cc));
        }
      }
    };
    const addDiamond = (row, col, radius) => {
      for (let dr = -radius; dr <= radius; dr += 1) {
        const span = radius - Math.abs(dr);
        for (let dc = -span; dc <= span; dc += 1) {
          const rr = row + dr;
          const cc = col + dc;
          if (inBounds(rr, cc)) visible.add(cellKey(rr, cc));
        }
      }
    };

    if (focusHeroId) {
      const hero = game.pieces[focusHeroId];
      if (hero && hero.hp > 0 && hero.team === team) addSquare(hero.row, hero.col, 3);
      return visible;
    }

    for (const piece of allUnits()) {
      if (piece.team === team && piece.hp > 0) addSquare(piece.row, piece.col, 3);
    }
    for (const tower of game.towers) {
      if (tower.team === team && tower.hp > 0) addDiamond(tower.row, tower.col, TOWER_CONFIG.RANGE);
    }
    for (const minion of game.minions) {
      if (minion.team === team && minion.hp > 0) addSquare(minion.row, minion.col, MINION_CONFIG.DETECT_RANGE);
    }
    return visible;
  }

  function visibleCellsForView() {
    if (!game) return new Set();
    const heroId = focusState.active ? focusState.heroId : null;
    if (
      visionCacheTick === game.tick &&
      visionCacheTeam === viewTeam &&
      visionCacheHero === heroId
    ) {
      return visionCache;
    }
    visionCacheTick = game.tick;
    visionCacheTeam = viewTeam;
    visionCacheHero = heroId;
    visionCache = collectVision(viewTeam, heroId);
    return visionCache;
  }

  function isCellVisibleToViewTeam(row, col) {
    if (editor.active) return true;
    if (!game) return true;
    return visibleCellsForView().has(cellKey(row, col));
  }

  function allyInSameGrass(entity, team) {
    const patch = grassPatchAt(entity.row, entity.col);
    if (!patch) return false;
    return allUnits().some(
      (ally) =>
        ally.team === team &&
        ally.hp > 0 &&
        grassPatchAt(ally.row, ally.col) === patch
    ) || game.minions.some(
      (ally) =>
        ally.team === team &&
        ally.hp > 0 &&
        grassPatchAt(ally.row, ally.col) === patch
    );
  }

  function isEntityVisibleToViewTeam(entity) {
    if (!entity) return false;
    if (editor.active || !game) return true;
    if (entity.team === viewTeam) return true;
    if (entity.type === "tower") return true;
    if (entity.hp <= 0) return false;
    if ((entity.revealedUntil || 0) > game.tick) return true;
    if (isEntityInGrass(entity) && allyInSameGrass(entity, viewTeam)) return true;
    if (!isCellVisibleToViewTeam(entity.row, entity.col)) return false;
    if (isEntityInGrass(entity)) return false;
    return true;
  }

  function isCellVisibleForMinimap(row, col) {
    return isCellVisibleToViewTeam(row, col);
  }

  function isInAttackRange(a, b) {
    if (!a || !b || a.hp <= 0 || b.hp <= 0 || a.team === b.team) return false;
    if (a.type === "hero" && a.number === 3) {
      return manhattanDistance(a, b) <= TOWER_CONFIG.RANGE;
    }
    const distance = Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    if (distance === 1) return true;
    return distance === 0 && b.type === "minion";
  }

  function chebyshevDistance(a, b) {
    return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
  }

  function manhattanDistance(a, b) {
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
  }

  function isInMinionAttackRange(a, b) {
    return manhattanDistance(a, b) <= 1;
  }

  function isInTowerRange(tower, target) {
    return manhattanDistance(tower, target) <= TOWER_CONFIG.RANGE;
  }

  function cellInAttackRange(row, col, enemy) {
    if (!enemy || enemy.hp <= 0) return false;
    return Math.max(Math.abs(row - enemy.row), Math.abs(col - enemy.col)) === 1;
  }

  function enemiesInRange(piece) {
    return allCombatants().filter(
      (other) =>
        other.team !== piece.team &&
        other.hp > 0 &&
        isInAttackRange(piece, other) &&
        isEntityVisibleTo(piece, other)
    );
  }

  function chooseAttackTarget(piece) {
    const manualTarget = piece.manualTargetId ? findEntityById(piece.manualTargetId) : null;
    if (
      manualTarget &&
      manualTarget.hp > 0 &&
      isInAttackRange(piece, manualTarget) &&
      isEntityVisibleTo(piece, manualTarget)
    ) {
      return manualTarget;
    }

    const current = findEntityById(piece.attackTarget);
    const rankOf = (entity) =>
      entity?.type === "minion" ? 0 : entity?.type === "hero" ? 1 : 2;

    if (
      current &&
      current.hp > 0 &&
      isInAttackRange(piece, current) &&
      isEntityVisibleTo(piece, current)
    ) {
      const better = enemiesInRange(piece)
        .filter((candidate) => rankOf(candidate) < rankOf(current))
        .sort((a, b) => {
          const rank = rankOf(a) - rankOf(b);
          return rank !== 0 ? rank : a.hp - b.hp;
        })[0];
      if (!better) return current;
    }

    const candidates = enemiesInRange(piece);
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const aRank = a.type === "minion" ? 0 : a.type === "hero" ? 1 : 2;
      const bRank = b.type === "minion" ? 0 : b.type === "hero" ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
      if (a.hp !== b.hp) return a.hp - b.hp;
      return (a.number || 99) - (b.number || 99);
    });

    return candidates[0];
  }

  function teamHasLiving(teamId) {
    return livingUnits(teamId).length > 0;
  }

  function selectedHero() {
    const piece = selectedPiece();
    return piece && piece.skills && piece.hp > 0 ? piece : null;
  }

  function nearestEnemyDirection(piece) {
    const enemies = allCombatants().filter(
      (other) =>
        other.team !== piece.team &&
        other.hp > 0 &&
        isEntityVisibleTo(piece, other)
    );

    if (!enemies.length) return { dr: -1, dc: 0, label: "上" };

    enemies.sort((a, b) => {
      const aDistance = Math.abs(a.row - piece.row) + Math.abs(a.col - piece.col);
      const bDistance = Math.abs(b.row - piece.row) + Math.abs(b.col - piece.col);
      if (aDistance !== bDistance) return aDistance - bDistance;
      return (a.number || 99) - (b.number || 99);
    });

    const target = enemies[0];
    const dr = target.row - piece.row;
    const dc = target.col - piece.col;

    // Skill 2 only supports the four orthogonal directions. On a tie,
    // prefer the vertical axis.
    if (Math.abs(dr) >= Math.abs(dc)) {
      const step = Math.sign(dr) || -1;
      return { dr: step, dc: 0, label: directionLabel(step, 0) };
    }

    const step = Math.sign(dc) || 1;
    return { dr: 0, dc: step, label: directionLabel(0, step) };
  }

  function directionLabel(dr, dc) {
    if (dr < 0 && dc < 0) return "左上";
    if (dr < 0 && dc > 0) return "右上";
    if (dr > 0 && dc < 0) return "左下";
    if (dr > 0 && dc > 0) return "右下";
    if (dr < 0) return "上";
    if (dr > 0) return "下";
    if (dc < 0) return "左";
    if (dc > 0) return "右";
    return "原地";
  }

  function normalizeCardinalDirection(direction) {
    if (!direction) return { dr: -1, dc: 0, label: "上" };

    const dr = direction.dr || 0;
    const dc = direction.dc || 0;

    if (Math.abs(dr) >= Math.abs(dc)) {
      const step = Math.sign(dr) || -1;
      return { dr: step, dc: 0, label: directionLabel(step, 0) };
    }

    const step = Math.sign(dc) || 1;
    return { dr: 0, dc: step, label: directionLabel(0, step) };
  }

  function areaForDirection(originRow, originCol, direction) {
    const centerRow = originRow + direction.dr * 2;
    const centerCol = originCol + direction.dc * 2;
    const cells = [];

    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const row = centerRow + dr;
        const col = centerCol + dc;
        if (!inBounds(row, col)) continue;
        cells.push({
          row,
          col,
          center: dr === 0 && dc === 0
        });
      }
    }

    return cells;
  }

  function formatCooldown(frames) {
    if (frames <= 0) return "READY";
    return `${(frames * CONFIG.TICK_MS / 1000).toFixed(1)}s`;
  }

  function respawnSecondsForTime(gameMs) {
    const minutes = Math.max(0, gameMs / 60000);
    const config = RESPAWN_CONFIG;

    if (minutes < config.EARLY_END_MINUTES) {
      const step = Math.min(
        config.EARLY_END_MINUTES / config.EARLY_STEP_MINUTES,
        minutes / config.EARLY_STEP_MINUTES
      );
      const raw = config.BASE_SECONDS * Math.pow(config.EARLY_GROWTH, step);
      const finalRaw = config.BASE_SECONDS * Math.pow(
        config.EARLY_GROWTH,
        config.EARLY_END_MINUTES / config.EARLY_STEP_MINUTES
      );
      const correction = (config.EARLY_END_SECONDS - finalRaw) *
        Math.pow(step / (config.EARLY_END_MINUTES / config.EARLY_STEP_MINUTES), 2);
      return raw + correction;
    }

    if (minutes < config.MID_END_MINUTES) {
      const progress = (minutes - config.EARLY_END_MINUTES) /
        (config.MID_END_MINUTES - config.EARLY_END_MINUTES);
      return config.EARLY_END_SECONDS +
        (config.MID_END_SECONDS - config.EARLY_END_SECONDS) * progress;
    }

    if (minutes < config.HARD_END_MINUTES) {
      return Math.min(
        config.HARD_END_SECONDS,
        config.MID_END_SECONDS + (minutes - config.MID_END_MINUTES)
      );
    }

    return config.HARD_END_SECONDS;
  }

  function respawnTicksForTime(gameMs) {
    return Math.max(1, Math.round(respawnSecondsForTime(gameMs) * 10));
  }

  function tickHeroRespawns() {
    for (const piece of allUnits()) {
      if (piece.hp > 0 || piece.respawnTicks <= 0) continue;
      piece.respawnTicks -= 1;
      if (piece.respawnTicks <= 0) {
        reviveHero(piece);
      }
    }
  }

  function reviveHero(piece) {
    const spawns = activeMap.heroSpawns?.[piece.team] || [];
    const preferred = spawns[piece.number - 1] || piece;
    const free = (row, col) => {
      if (!isTile(row, col)) return false;
      if (game.towers.some((tower) => tower.row === row && tower.col === col)) return false;
      return !allUnits().some(
        (other) => other.id !== piece.id && other.hp > 0 && other.row === row && other.col === col
      );
    };

    let cell = { row: preferred.row, col: preferred.col };
    if (!free(cell.row, cell.col)) {
      cell = null;
      for (let radius = 1; radius <= 10 && !cell; radius += 1) {
        for (let dr = -radius; dr <= radius && !cell; dr += 1) {
          for (let dc = -radius; dc <= radius; dc += 1) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const row = preferred.row + dr;
            const col = preferred.col + dc;
            if (!free(row, col)) continue;
            cell = { row, col };
            break;
          }
        }
      }
    }

    if (!cell) cell = { row: preferred.row, col: preferred.col };

    piece.row = cell.row;
    piece.col = cell.col;
    piece.hp = piece.maxHp;
    piece.state = "idle";
    piece.path = [];
    piece.destination = null;
    piece.reroute = null;
    piece.aiMove = false;
    piece.attackTarget = null;
    piece.attackCharge = 0;
    piece.attackResume = null;
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.anim = null;
    piece.landedAt = null;
    piece.aim = null;
    piece.cast = null;
    piece.respawnTicks = 0;
    piece.respawnTotal = 0;
    piece.lastCommandTick = game.tick;
    piece.revealedUntil = 0;
    piece.queuedAttack = false;
    piece.trackMove = false;
    piece.manualTargetId = null;
    piece.manualTargetLast = null;
    piece.aiLaneMode = "assigned";
    piece.aiMove = false;

    addLog("复活", "system", `${piece.name} 在 ${cellLabel(cell.row, cell.col)} 复活。`);
    renderPieces();
  }

  function cellLabel(row, col) {
    const start = CONFIG.CORE_OFFSET;
    const end = start + CONFIG.CORE_SIZE;
    if (row >= start && row < end && col >= start && col < end) {
      return `${COLUMNS[col - start]}${end - row}`;
    }
    return `R${row + 1}C${col + 1}`;
  }

  function routeTicks(cellCount) {
    if (cellCount <= 0) return 0;
    return (
      cellCount * CONFIG.MOVE_STEP_TICKS +
      Math.max(0, cellCount - 1) * CONFIG.MOVE_RECOVERY_TICKS
    );
  }

  function formatEta(ticks) {
    return `${(ticks * CONFIG.TICK_MS / 1000).toFixed(1)}s`;
  }

  function formatTime(ms) {
    const totalTenths = Math.floor(ms / 100);
    const minutes = Math.floor(totalTenths / 600);
    const seconds = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace("#", "");
    const red = parseInt(clean.slice(0, 2), 16);
    const green = parseInt(clean.slice(2, 4), 16);
    const blue = parseInt(clean.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  /* ---------------------------------------------------------
     Pathfinding: shortest path, biased toward the straight line
     --------------------------------------------------------- */

  function lineDeviationSq(row, col, startRow, startCol, targetRow, targetCol) {
    const dx = targetCol - startCol;
    const dy = targetRow - startRow;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return 0;

    const cross = (col - startCol) * dy - (row - startRow) * dx;
    return (cross * cross) / lengthSq;
  }

  function findPath(piece, targetRow, targetCol) {
    return findPathFrom(piece.row, piece.col, targetRow, targetCol, piece.id, piece);
  }

  function findPathFrom(startRow, startCol, targetRow, targetCol, ignoreId, mover = null) {
    if (!inBounds(startRow, startCol) || !inBounds(targetRow, targetCol)) return null;
    if (startRow === targetRow && startCol === targetCol) return [];
    if (isOccupied(targetRow, targetCol, ignoreId, mover)) return null;

    const direct = buildLinePath(startRow, startCol, targetRow, targetCol, ignoreId, mover);
    if (direct) return direct;

    const size = CONFIG.SIZE;
    const total = size * size;
    const startIndex = startRow * size + startCol;
    const targetIndex = targetRow * size + targetCol;
    const dist = new Float64Array(total);
    const parents = new Int16Array(total);
    dist.fill(Infinity);
    parents.fill(-1);

    const verticalMajor = Math.abs(targetRow - startRow) >= Math.abs(targetCol - startCol);
    const heap = new MinHeap();
    dist[startIndex] = 0;
    heap.push({ index: startIndex, cost: 0 });

    while (heap.size) {
      const current = heap.pop();
      if (!current) break;
      if (current.cost > dist[current.index] + 1e-7) continue;
      if (current.index === targetIndex) break;

      const row = Math.floor(current.index / size);
      const col = current.index % size;

      for (const [dr, dc] of DIRECTIONS) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (!inBounds(nextRow, nextCol)) continue;
        if (!canStepBetween(row, col, nextRow, nextCol)) continue;
        if (isOccupied(nextRow, nextCol, ignoreId, mover)) continue;

        const nextIndex = nextRow * size + nextCol;
        let stepCost =
          PATH_STEP_COST +
          lineDeviationSq(nextRow, nextCol, startRow, startCol, targetRow, targetCol);

        // For diagonal movement, prefer making the vertical move first on ties.
        if (
          current.index === startIndex &&
          verticalMajor &&
          dr === 0 &&
          dc !== 0
        ) {
          stepCost += FIRST_HORIZONTAL_BIAS;
        }

        const nextCost = current.cost + stepCost;
        if (nextCost + 1e-7 < dist[nextIndex]) {
          dist[nextIndex] = nextCost;
          parents[nextIndex] = current.index;
          heap.push({ index: nextIndex, cost: nextCost });
        }
      }
    }

    if (!Number.isFinite(dist[targetIndex])) return null;

    const path = [];
    let cursor = targetIndex;
    while (cursor !== startIndex) {
      path.push({
        row: Math.floor(cursor / size),
        col: cursor % size
      });
      cursor = parents[cursor];
      if (cursor === -1) return null;
    }

    path.reverse();
    return path;
  }

  // Greedy straight-line staircase. It always reduces Manhattan distance,
  // so a successful result is also a shortest path.
  function buildLinePath(startRow, startCol, targetRow, targetCol, ignoreId, mover = null) {
    const dx = targetCol - startCol;
    const dy = targetRow - startRow;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const total = Math.abs(dx) + Math.abs(dy);
    if (total === 0) return [];

    let row = startRow;
    let col = startCol;
    const path = [];

    for (let step = 1; step <= total; step += 1) {
      const idealX = startCol + (dx * step) / total;
      const idealY = startRow + (dy * step) / total;

      const options = [];
      if (row !== targetRow) {
        options.push({ row: row + sy, col, axis: "v" });
      }
      if (col !== targetCol) {
        options.push({ row, col: col + sx, axis: "h" });
      }

      options.sort((a, b) => {
        const aDistance = (a.col - idealX) ** 2 + (a.row - idealY) ** 2;
        const bDistance = (b.col - idealX) ** 2 + (b.row - idealY) ** 2;
        if (Math.abs(aDistance - bDistance) > 1e-9) return aDistance - bDistance;
        return a.axis === "v" ? -1 : 1;
      });

      let next = null;
      for (const option of options) {
        if (!canStepBetween(row, col, option.row, option.col)) continue;
        if (!isOccupied(option.row, option.col, ignoreId, mover)) {
          next = option;
          break;
        }
      }

      if (!next) return null;

      row = next.row;
      col = next.col;
      path.push({ row, col });
    }

    return row === targetRow && col === targetCol ? path : null;
  }

  /* ---------------------------------------------------------
     Visual animation helpers
     --------------------------------------------------------- */

  function startCellAnimation(piece, duration = MOVE_ANIM_MS) {
    if (!piece.path.length) return;
    const next = piece.path[0];

    piece.anim = {
      fromRow: piece.row,
      fromCol: piece.col,
      toRow: next.row,
      toCol: next.col,
      startedAt: visualTime,
      duration,
      landed: false
    };
    piece.landedAt = null;
  }

  function visualPosition(piece) {
    let x = pos(piece.col);
    let y = pos(piece.row);
    let scaleX = 1;
    let scaleY = 1;
    let lift = 0;

    if (piece.anim) {
      const anim = piece.anim;
      const raw = (visualTime - anim.startedAt) / anim.duration;
      const t = clamp01(raw);
      const eased = normalEase(t);

      x = pos(anim.fromCol) + (pos(anim.toCol) - pos(anim.fromCol)) * eased;
      y = pos(anim.fromRow) + (pos(anim.toRow) - pos(anim.fromRow)) * eased;

      if (!anim.landed && raw >= 1) {
        anim.landed = true;
        piece.landedAt = visualTime;
      }

      if (!REDUCE_MOTION) {
        const motionSpeed = raw > 0 && raw < 1 ? normalSpeed(t) : 0;
        const deform = motionSpeed * 0.11;
        if (anim.toCol !== anim.fromCol) {
          scaleX += deform;
          scaleY -= deform * 0.72;
        } else {
          scaleY += deform;
          scaleX -= deform * 0.72;
        }
        lift -= Math.sin(Math.PI * t) * 2;
      }
    }

    if (!REDUCE_MOTION && piece.landedAt != null) {
      const elapsed = (visualTime - piece.landedAt) / 1000;

      if (elapsed >= 0 && elapsed < 0.34) {
        const pulse = Math.exp(-elapsed * 11) * Math.cos(elapsed * 34);
        scaleX *= 1 + pulse * 0.11;
        scaleY *= 1 - pulse * 0.085;
        lift -= Math.max(0, pulse) * 1.8;
      }
    }

    return { x, y, scaleX, scaleY, lift };
  }

  function renderPieces() {
    if (!game) return;

    for (const piece of allUnits()) {
      const element = pieceEls[piece.id];
      const { x, y, scaleX, scaleY, lift } = visualPosition(piece);
      element.root.style.left = `${x}%`;
      element.root.style.top = `${y}%`;
      element.body.style.transform = `translateY(${lift.toFixed(2)}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    }

    for (const minion of game.minions) {
      const element = minionEls[minion.id];
      if (!element) continue;
      const { x, y, scaleX, scaleY, lift } = visualPosition(minion);
      element.root.style.left = `${x}%`;
      element.root.style.top = `${y}%`;
      element.body.style.transform = `translateY(${lift.toFixed(2)}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    }
  }

  /* ---------------------------------------------------------
     Main loop / simulation
     --------------------------------------------------------- */

  function loop(now) {
    const delta = Math.min(now - lastFrame, CONFIG.TICK_MS * 3);
    lastFrame = now;
    accumulator += delta;

    if (!paused && !editor.active) {
      visualTime += delta;
    }

    let steps = 0;
    while (accumulator >= CONFIG.TICK_MS && steps < 4 && !editor.active) {
      logicTick();
      accumulator -= CONFIG.TICK_MS;
      steps += 1;
    }

    if (steps === 4) accumulator = 0;

    renderPieces();
    requestAnimationFrame(loop);
  }

  function logicTick() {
    if (editor.active) return;
    game.tick += 1;
    if (game.status !== "playing" || paused) return;

    game.gameMs += CONFIG.TICK_MS;
    tickSkillCooldowns();
    tickHeroRespawns();
    tickMinionSpawner();

    const pendingStrikes = [];
    tickTowers(pendingStrikes);

    for (const piece of allUnits()) {
      tickUnit(piece, pendingStrikes);
    }

    for (const minion of [...game.minions]) {
      tickMinion(minion, pendingStrikes);
    }

    tickManualTargets();
    tickFocusControl();

    for (const piece of allUnits()) {
      tickHeroAI(piece);
    }

    // Idle guards react after all movement, so arrival order cannot matter.
    triggerIdleGuards();

    if (pendingStrikes.length) {
      resolveStrikes(pendingStrikes);
    }

    updateAutoAimDirections();
    syncAll();
  }

  function tickSkillCooldowns() {
    for (const piece of allUnits()) {
      if (!piece.skills) continue;
      for (const slot of [1, 2]) {
        const skill = piece.skills[slot];
        if (skill) skill.cooldown = Math.max(0, skill.cooldown - 1);
      }
    }
  }

  function updateAutoAimDirections() {
    for (const piece of allUnits()) {
      if (piece.hp <= 0 || !piece.aim || piece.aim.skill !== 2) continue;
      if (piece.skills?.[2]?.id !== "shock") continue;
      const direction = nearestEnemyDirection(piece);
      piece.aim.direction = direction;
    }
  }

  function setLockTeam(team, silent = false) {
    lockTeam = team === "red" ? "red" : "blue";
    viewTeam = lockTeam;
    visionCacheTick = -1;
    const previous = selectedPiece();
    if (previous) previous.aim = null;
    if (game?.selected) {
      const selected = game.pieces[game.selected];
      if (selected && selected.team !== lockTeam) {
        game.selected = null;
        game.hoverPlan = null;
      }
    }
    if (focusState.active) {
      const current = focusedHero();
      const number = current ? current.number : 1;
      const next = game?.pieces?.[`${lockTeam}-${number}`];
      if (next && next.hp > 0) enterFocusMode(next, true);
      else {
        const fallback = livingUnits(lockTeam)[0];
        if (fallback) enterFocusMode(fallback, true);
        else exitFocusMode(true);
      }
    }
    if (!silent) {
      showToast(`${TEAM_DEFS[viewTeam].name}视角 · 锁定${TEAM_DEFS[lockTeam].name}英雄`);
      syncAll(true);
    }
  }

  function resetControlState() {
    focusState.active = false;
    focusState.heroId = null;
    focusState.keys.clear();
    focusState.lastKey = null;
    focusState.lastDir = null;
    focusState.nextMoveTick = 0;
    lockTeam = "blue";
    viewTeam = "blue";
    rallyArmed = false;
    visionCacheTick = -1;
    if (els.focusHud) els.focusHud.hidden = true;
    if (els.focusFrame) els.focusFrame.classList.remove("is-visible");
    if (els.board) els.board.style.transform = "";
    document.body.classList.remove("is-focused", "is-rallying");
  }

  function toggleLockTeam() {
    setLockTeam(lockTeam === "blue" ? "red" : "blue");
  }

  function selectLockedHero(number) {
    if (!game || game.status !== "playing") return;
    const piece = game.pieces[`${lockTeam}-${number}`];
    if (!piece || piece.hp <= 0) {
      showToast(`${TEAM_DEFS[lockTeam].name}${number}号英雄不在场。`);
      return;
    }
    viewTeam = lockTeam;
    visionCacheTick = -1;
    const previous = selectedPiece();
    if (previous) previous.aim = null;
    if (focusState.active) {
      enterFocusMode(piece, true);
    } else {
      game.selected = piece.id;
      game.hoverPlan = null;
      syncAll(true);
    }
  }

  function enterFocusMode(hero, silent = false) {
    if (!hero || hero.hp <= 0 || game.status !== "playing") return false;
    focusState.active = true;
    focusState.heroId = hero.id;
    focusState.keys.clear();
    focusState.lastKey = null;
    focusState.lastDir = null;
    focusState.nextMoveTick = game.tick;
    hero.queuedAttack = false;
    hero.manualTargetId = null;
    hero.manualTargetLast = null;
    hero.trackMove = false;
    game.markedTargetId = null;
    game.rallyPoint = null;
    rallyArmed = false;
    document.body.classList.remove("is-rallying");
    hero.aim = null;
    lockTeam = hero.team;
    viewTeam = hero.team;
    visionCacheTick = -1;
    game.selected = hero.id;
    game.hoverPlan = null;
    clearHoverVisuals();
    if (!silent) showToast(`${hero.name} · 专注模式 · P 退出`);
    syncAll(true);
    return true;
  }

  function exitFocusMode(silent = false) {
    if (!focusState.active) return;
    const hero = game?.pieces?.[focusState.heroId];
    if (hero) hero.queuedAttack = false;
    focusState.active = false;
    focusState.heroId = null;
    focusState.keys.clear();
    focusState.lastKey = null;
    focusState.lastDir = null;
    if (els.focusHud) els.focusHud.hidden = true;
    if (els.focusFrame) els.focusFrame.classList.remove("is-visible");
    if (els.board) els.board.style.transform = "";
    document.body.classList.remove("is-focused");
    visionCacheTick = -1;
    if (!silent) syncAll(true);
  }

  function toggleFocusMode() {
    if (focusState.active) {
      exitFocusMode(false);
      return;
    }
    const selected = selectedPiece();
    let hero = selected && selected.hp > 0 && selected.team === lockTeam ? selected : null;
    if (!hero) hero = livingUnits(lockTeam)[0] || null;
    if (!hero) {
      showToast("没有可锁定的英雄。");
      return;
    }
    enterFocusMode(hero, false);
  }

  function focusSkill(slot) {
    const hero = focusedHero();
    if (!hero) return false;
    const skill = hero.skills?.[slot];
    if (!skill) {
      showToast("该英雄没有这个技能。");
      return false;
    }
    const def = SKILL_LIBRARY[skill.id];
    if (skill.cooldown > 0) {
      showToast(`${def.name}冷却中 · ${formatCooldown(skill.cooldown)}`);
      return false;
    }

    if (skill.id === "heal") return castHeal(hero, false);
    if (skill.id === "empower") return activateEmpower(hero);

    const direction = focusState.lastDir || nearestEnemyDirection(hero);
    if (skill.id === "blink") return performBlink(hero, direction);
    if (skill.id === "shock") return startSkill2(hero, direction);
    return false;
  }

  function requestFocusAttack() {
    const hero = focusedHero();
    if (!hero) return;
    if (hero.state === "idle") {
      const target = chooseAttackTarget(hero);
      if (target) beginAttack(hero, target, "focus");
      return;
    }
    hero.queuedAttack = true;
  }

  function focusStep(hero, direction) {
    if (!hero || hero.state !== "idle") return false;
    const row = hero.row + direction.dr;
    const col = hero.col + direction.dc;
    if (!isTile(row, col) || isWallBetween(hero.row, hero.col, row, col)) return false;
    if (isOccupied(row, col, hero.id, hero)) return false;

    hero.path = [{ row, col }];
    hero.destination = { row, col };
    hero.state = "moving";
    hero.moveProgress = 0;
    hero.recoveryTicks = 0;
    hero.attackTarget = null;
    hero.attackCharge = 0;
    hero.attackResume = null;
    hero.reroute = null;
    hero.aiMove = false;
    hero.trackMove = false;
    hero.queuedAttack = false;
    hero.manualTargetId = null;
    hero.manualTargetLast = null;
    hero.lastCommandTick = game.tick;
    hero.anim = null;
    hero.landedAt = null;
    startCellAnimation(hero);
    return true;
  }

  function tickFocusControl() {
    if (!focusState.active || game.status !== "playing") return;
    const hero = focusedHero();
    if (!hero) {
      exitFocusMode(true);
      return;
    }
    if (isEntityInGrass(hero)) revealEntity(hero);

    if (hero.state === "idle" && hero.queuedAttack) {
      const target = chooseAttackTarget(hero);
      hero.queuedAttack = false;
      if (target) {
        hero.attackResume = null;
        hero.destination = null;
        hero.path = [];
        beginAttack(hero, target, "focus");
        return;
      }
    }

    if (!focusState.keys.size || hero.state !== "idle") return;
    if (game.tick < focusState.nextMoveTick) return;

    const direction = focusState.lastDir;
    if (!direction) return;
    const moved = focusStep(hero, direction);
    focusState.nextMoveTick = game.tick + (moved
      ? CONFIG.MOVE_STEP_TICKS + CONFIG.MOVE_RECOVERY_TICKS
      : 2);
  }

  function commandTrackTarget(piece, target) {
    if (!piece || !target || piece.hp <= 0 || target.hp <= 0 || piece.team === target.team) return false;
    piece.manualTargetId = target.id;
    piece.manualTargetLast = { row: target.row, col: target.col };
    piece.lastCommandTick = game.tick;
    piece.aiLaneMode = "assigned";
    piece.aim = null;
    piece.queuedAttack = false;
    game.markedTargetId = target.id;
    game.rallyPoint = null;
    addLog("标记", "attack", `${piece.name} 锁定 ${target.name}，开始跟踪。`);
    syncAll(true);
    return true;
  }

  function issueChaseMove(piece, target) {
    if (!target) return false;
    if (piece.row === target.row && piece.col === target.col) return false;
    const path = findPathFrom(piece.row, piece.col, target.row, target.col, piece.id, piece);
    if (!path || !path.length) return false;
    piece.path = path.map((step) => ({ row: step.row, col: step.col }));
    piece.destination = { row: target.row, col: target.col };
    piece.state = "moving";
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.attackTarget = null;
    piece.attackCharge = 0;
    piece.attackResume = null;
    piece.reroute = null;
    piece.aiMove = true;
    piece.trackMove = true;
    piece.anim = null;
    piece.landedAt = null;
    startCellAnimation(piece);
    return true;
  }

  function tickManualTargets() {
    if (game.status !== "playing") return;
    for (const piece of allUnits()) {
      if (!piece.manualTargetId || piece.hp <= 0 || isFocusedHero(piece)) continue;
      const target = findEntityById(piece.manualTargetId);
      if (!target || target.hp <= 0 || !isEntityVisibleTo(piece, target)) {
        piece.manualTargetId = null;
        piece.manualTargetLast = null;
        if (game.markedTargetId === target?.id) game.markedTargetId = null;
        continue;
      }
      piece.manualTargetLast = { row: target.row, col: target.col };

      if (isInAttackRange(piece, target)) {
        piece.attackResume = null;
        piece.destination = null;
        piece.path = [];
        if (piece.state === "idle") beginAttack(piece, target, "focus");
        continue;
      }

      if (piece.state !== "idle" || game.tick % 5 !== 0) continue;
      const cell = findApproachCell(piece, target, true);
      if (cell) issueChaseMove(piece, cell);
    }
  }

  function nearestRallyCell(row, col, used) {
    if (
      isTile(row, col) &&
      !used.has(cellKey(row, col)) &&
      !game.towers.some((tower) => tower.row === row && tower.col === col) &&
      !allUnits().some((piece) => piece.hp > 0 && piece.row === row && piece.col === col)
    ) {
      return { row, col };
    }
    for (let radius = 1; radius <= 6; radius += 1) {
      for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const rr = row + dr;
          const cc = col + dc;
          if (!isTile(rr, cc)) continue;
          if (used.has(cellKey(rr, cc))) continue;
          if (game.towers.some((tower) => tower.row === rr && tower.col === cc)) continue;
          if (game.pieces && Object.values(game.pieces).some(
            (piece) => piece.hp > 0 && piece.row === rr && piece.col === cc
          )) continue;
          return { row: rr, col: cc };
        }
      }
    }
    return null;
  }

  function rallyAllHeroes(row, col) {
    if (game.status !== "playing" || focusState.active) return false;
    const heroes = livingUnits(viewTeam);
    if (!heroes.length) return false;
    const used = new Set();
    let moved = 0;

    heroes.forEach((hero, index) => {
      const target = nearestRallyCell(row, col, used);
      if (!target) return;
      used.add(cellKey(target.row, target.col));
      const path = findPathFrom(hero.row, hero.col, target.row, target.col, hero.id, hero);
      if (!path || !path.length) return;

      hero.path = path.map((step) => ({ row: step.row, col: step.col }));
      hero.destination = { row: target.row, col: target.col };
      hero.state = "moving";
      hero.moveProgress = 0;
      hero.recoveryTicks = 0;
      hero.attackTarget = null;
      hero.attackCharge = 0;
      hero.attackResume = null;
      hero.reroute = null;
      hero.anim = null;
      hero.landedAt = null;
      hero.aim = null;
      hero.cast = null;
      hero.aiMove = true;
      hero.trackMove = true;
      hero.manualTargetId = null;
      hero.manualTargetLast = null;
      hero.queuedAttack = false;
      hero.aiLaneMode = "nearest";
      hero.lastCommandTick = game.tick;
      startCellAnimation(hero);
      moved += 1;
    });

    game.rallyPoint = { row, col };
    game.markedTargetId = null;
    rallyArmed = false;
    document.body.classList.remove("is-rallying");
    addLog("集合", "move", `${TEAM_DEFS[viewTeam].name}全队向 ${cellLabel(row, col)} 集合。`);
    showToast(`${TEAM_DEFS[viewTeam].name}全队集合。`);
    syncAll(true);
    return moved > 0;
  }

  function triggerIdleGuards() {
    if (game.status !== "playing") return;

    for (const piece of allUnits()) {
      if (piece.state !== "idle" || piece.hp <= 0 || isFocusedHero(piece)) continue;
      const target = chooseAttackTarget(piece);
      if (target) beginAttack(piece, target, "guard");
    }
  }

  /* ---------------------------------------------------------
     Autonomous hero pathing
     --------------------------------------------------------- */

  function heroLaneIndex(piece) {
    if (piece.aiLaneMode === "nearest") {
      let best = 0;
      let bestDistance = Infinity;
      (activeMap.lanes || []).forEach((lane, index) => {
        if (!lane || !lane.cells.length) return;
        const distance = lane.cells.reduce((minimum, cell) => Math.min(
          minimum,
          Math.abs(cell.row - piece.row) + Math.abs(cell.col - piece.col)
        ), Infinity);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      return best;
    }
    if (piece.number === 1 || piece.number === 2) return 0;
    if (piece.number === 3 || piece.number === 4) return 2;
    return 1;
  }

  function laneNearestIndexForHero(piece, lane) {
    if (!lane || !lane.cells.length) return 0;
    let best = 0;
    let bestDistance = Infinity;
    lane.cells.forEach((cell, index) => {
      const distance = Math.abs(cell.row - piece.row) + Math.abs(cell.col - piece.col);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  function towerHasFriendlyMinion(piece, tower) {
    return game.minions.some(
      (minion) =>
        minion.team === piece.team &&
        minion.hp > 0 &&
        isInTowerRange(tower, minion)
    );
  }

  function isCellUnsafeFromEnemyTowers(piece, row, col) {
    return game.towers.some(
      (tower) =>
        tower.team !== piece.team &&
        tower.hp > 0 &&
        manhattanDistance(tower, { row, col }) <= TOWER_CONFIG.RANGE &&
        !towerHasFriendlyMinion(piece, tower)
    );
  }

  function isCellFreeForHero(piece, row, col, allowUnsafe = false) {
    return isTile(row, col) &&
      (allowUnsafe || !isCellUnsafeFromEnemyTowers(piece, row, col)) &&
      !isOccupied(row, col, piece.id, piece);
  }

  function cellInHeroAttackRange(piece, target, row, col) {
    if (piece.number === 3) {
      return Math.abs(row - target.row) + Math.abs(col - target.col) <= TOWER_CONFIG.RANGE;
    }
    const distance = Math.max(Math.abs(row - target.row), Math.abs(col - target.col));
    return distance === 1 || (distance === 0 && target.type === "minion");
  }

  function visibleEnemiesForAI(piece) {
    return allCombatants().filter(
      (target) =>
        target.team !== piece.team &&
        target.hp > 0 &&
        chebyshevDistance(piece, target) <= 3 &&
        isEntityVisibleTo(piece, target)
    );
  }

  function nearestEntity(piece, list) {
    return [...list].sort(
      (a, b) => manhattanDistance(piece, a) - manhattanDistance(piece, b)
    )[0] || null;
  }

  function chooseAITarget(piece) {
    const visible = visibleEnemiesForAI(piece);
    if (!visible.length) return null;

    const minions = visible.filter((target) => target.type === "minion");
    if (minions.length) {
      return { target: nearestEntity(piece, minions), retreat: false };
    }

    const heroes = visible.filter((target) => target.type === "hero");
    if (heroes.length) {
      const weaker = heroes.filter((target) => piece.hp > target.hp);
      if (weaker.length) {
        return { target: nearestEntity(piece, weaker), retreat: false };
      }
      return { target: nearestEntity(piece, heroes), retreat: true };
    }

    const towers = visible.filter((target) => target.type === "tower");
    if (towers.length) {
      return { target: nearestEntity(piece, towers), retreat: false };
    }

    return null;
  }

  function findApproachCell(piece, target, allowUnsafe = false) {
    if (isInAttackRange(piece, target)) return null;

    let best = null;
    let bestLength = Infinity;
    for (let row = target.row - TOWER_CONFIG.RANGE; row <= target.row + TOWER_CONFIG.RANGE; row += 1) {
      for (let col = target.col - TOWER_CONFIG.RANGE; col <= target.col + TOWER_CONFIG.RANGE; col += 1) {
        if (!inBounds(row, col)) continue;
        if (row === target.row && col === target.col) continue;
        if (!cellInHeroAttackRange(piece, target, row, col)) continue;
        if (!isCellFreeForHero(piece, row, col, allowUnsafe)) continue;
        const path = findPathFrom(piece.row, piece.col, row, col, piece.id, piece);
        if (!path || path.length >= bestLength) continue;
        bestLength = path.length;
        best = { row, col };
      }
    }
    return best;
  }

  function laneObjectiveFor(piece) {
    const enemyCrystal = game.towers.find(
      (tower) => tower.team !== piece.team && tower.isCrystal && tower.hp > 0
    );
    if (enemyCrystal) return enemyCrystal;
    const enemySpawn = activeMap.heroSpawns?.[piece.team === "red" ? "blue" : "red"]?.[4];
    return enemySpawn ? { row: enemySpawn.row, col: enemySpawn.col } : null;
  }

  function findLaneAdvanceCell(piece) {
    const lane = activeMap.lanes?.[heroLaneIndex(piece)];
    if (!lane || lane.cells.length < 2) return null;

    const direction = piece.team === "blue" ? 1 : -1;
    const start = laneNearestIndexForHero(piece, lane);
    const objective = laneObjectiveFor(piece);
    let best = null;
    let bestScore = Infinity;

    for (let index = start; index >= 0 && index < lane.cells.length; index += direction) {
      const cell = lane.cells[index];
      if (!isCellFreeForHero(piece, cell.row, cell.col)) continue;
      const distance = objective ? manhattanDistance(cell, objective) : 0;
      if (distance < bestScore) {
        bestScore = distance;
        best = cell;
      }
    }

    return best;
  }

  function findRetreatCell(piece, enemyHero) {
    const lane = activeMap.lanes?.[heroLaneIndex(piece)];
    if (!lane || lane.cells.length < 2) return null;

    const direction = piece.team === "blue" ? 1 : -1;
    const start = laneNearestIndexForHero(piece, lane);
    let best = null;
    let bestDistance = manhattanDistance(piece, enemyHero);

    for (let distance = 1; distance <= 8; distance += 1) {
      const index = start - direction * distance;
      if (index < 0 || index >= lane.cells.length) break;
      const cell = lane.cells[index];
      if (!isCellFreeForHero(piece, cell.row, cell.col)) continue;
      const away = manhattanDistance(cell, enemyHero);
      if (away >= bestDistance) {
        bestDistance = away;
        best = cell;
      }
    }
    return best;
  }

  function trimAIPathForTowers(piece, path) {
    if (!path || !path.length) return [];
    if (piece.trackMove) return path;
    if (isCellUnsafeFromEnemyTowers(piece, piece.row, piece.col)) return path;
    const safe = [];
    for (const step of path) {
      if (isCellUnsafeFromEnemyTowers(piece, step.row, step.col)) break;
      safe.push(step);
    }
    return safe;
  }

  function issueAIMove(piece, target) {
    if (!target) return false;
    if (piece.row === target.row && piece.col === target.col) return false;

    let path = findPathFrom(piece.row, piece.col, target.row, target.col, piece.id, piece);
    path = trimAIPathForTowers(piece, path);
    if (!path || !path.length) return false;

    piece.path = path.map((step) => ({ row: step.row, col: step.col }));
    piece.destination = { row: target.row, col: target.col };
    piece.state = "moving";
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.attackTarget = null;
    piece.attackCharge = 0;
    piece.attackResume = null;
    piece.reroute = null;
    piece.anim = null;
    piece.landedAt = null;
    if (!chooseAttackTarget(piece)) startCellAnimation(piece);
    piece.aiMove = true;
    piece.trackMove = false;
    return true;
  }

  function tickHeroAI(piece) {
    if (game.status !== "playing" || piece.hp <= 0 || piece.aim || piece.cast) return;
    if (isFocusedHero(piece) || piece.manualTargetId) return;
    if (game.tick - piece.lastCommandTick <= 30) return;

    if (piece.skills?.[1]?.id === "heal") {
      tryAutoHeal(piece);
    }

    if (piece.state !== "idle") return;

    const decision = chooseAITarget(piece);
    if (decision?.retreat) {
      const cell = findRetreatCell(piece, decision.target);
      if (cell) issueAIMove(piece, cell);
      return;
    }

    if (decision?.target) {
      if (isInAttackRange(piece, decision.target)) return;
      const cell = findApproachCell(piece, decision.target);
      if (cell) {
        issueAIMove(piece, cell);
        return;
      }
    }

    const laneCell = findLaneAdvanceCell(piece);
    if (laneCell) issueAIMove(piece, laneCell);
  }

  function tickUnit(piece, pendingStrikes) {
    if (game.status !== "playing" || piece.hp <= 0) return;

    /* --- upgraded skill cast ------------------------------- */
    if (piece.state === "casting") {
      tickCast(piece);
      return;
    }

    /* --- recovery after a move step ----------------------- */
    if (piece.state === "recovering") {
      piece.recoveryTicks = Math.max(0, piece.recoveryTicks - 1);
      if (piece.recoveryTicks > 0) return;

      const target = isFocusedHero(piece) ? null : chooseAttackTarget(piece);
      if (target) {
        beginAttack(piece, target, "move");
        return;
      }

      if (piece.path.length) {
        piece.state = "moving";
        piece.moveProgress = 0;
        startCellAnimation(piece);
        return;
      }

      piece.state = "idle";
      piece.aiMove = false;
      piece.trackMove = false;
      piece.destination = null;
      return;
    }

    /* --- auto combat -------------------------------------- */
    if (piece.state === "attacking") {
      const target = chooseAttackTarget(piece);

      if (!target) {
        stopAttack(piece);
        return;
      }

      piece.attackTarget = target.id;
      piece.attackCharge += 1;

      if (piece.attackCharge >= CONFIG.ATTACK_INTERVAL_TICKS) {
        const empowered = piece.type === "hero" && piece.number === 3 && piece.empowerCharges > 0;
        pendingStrikes.push({
          attacker: piece,
          target,
          damage: empowered ? 3 : piece.damage
        });
        if (empowered) piece.empowerCharges -= 1;
        piece.attackCharge = 0;
      }
      return;
    }

    /* --- movement ----------------------------------------- */
    if (piece.state === "moving") {
      if (!piece.path.length) {
        piece.state = "idle";
        piece.aiMove = false;
        piece.trackMove = false;
        piece.destination = null;
        return;
      }

      if (piece.moveProgress === 0) {
        const target = isFocusedHero(piece) ? null : chooseAttackTarget(piece);
        if (target) {
          beginAttack(piece, target, "move");
          return;
        }

        const next = piece.path[0];
        if (
          piece.aiMove &&
          !piece.trackMove &&
          !isCellUnsafeFromEnemyTowers(piece, piece.row, piece.col) &&
          isCellUnsafeFromEnemyTowers(piece, next.row, next.col)
        ) {
          stopAIMoveSilently(piece);
          return;
        }
        if (isOccupied(next.row, next.col, piece.id, piece)) {
          if (piece.aiMove || piece.trackMove) {
            stopAIMoveSilently(piece);
          } else {
            abortMove(piece, "路线被友军或敌军占据，移动中止。");
          }
          return;
        }
      }

      piece.moveProgress += 1;

      if (piece.moveProgress >= CONFIG.MOVE_STEP_TICKS) {
        const next = piece.path[0];

        if (
          piece.aiMove &&
          !piece.trackMove &&
          !isCellUnsafeFromEnemyTowers(piece, piece.row, piece.col) &&
          isCellUnsafeFromEnemyTowers(piece, next.row, next.col)
        ) {
          piece.moveProgress = 0;
          stopAIMoveSilently(piece);
          return;
        }
        if (isOccupied(next.row, next.col, piece.id, piece)) {
          piece.moveProgress = 0;
          if (piece.aiMove || piece.trackMove) {
            stopAIMoveSilently(piece);
          } else {
            abortMove(piece, "落点被占据，移动中止。");
          }
          return;
        }

        piece.path.shift();
        piece.row = next.row;
        piece.col = next.col;
        piece.moveProgress = 0;

        if (piece.reroute) {
          const queued = piece.reroute;
          piece.reroute = null;
          piece.path = queued.path.map((step) => ({ row: step.row, col: step.col }));
          piece.destination = { row: queued.target.row, col: queued.target.col };
        }

        piece.state = "recovering";
        piece.recoveryTicks = CONFIG.MOVE_RECOVERY_TICKS;
      }
    }
  }

  function tickMinionSpawner() {
    const lanes = activeMap.lanes || [];
    if (!lanes.some(Boolean)) return;

    if (game.tick >= game.nextWaveTick) {
      for (const team of ["blue", "red"]) {
        lanes.forEach((lane, laneIndex) => {
          if (!lane || lane.cells.length < 2) return;
          for (let index = 0; index < LANE_CONFIG.MINIONS_PER_LANE; index += 1) {
            game.minionSpawnQueue.push({
              due: game.tick + index * LANE_CONFIG.SPAWN_GAP,
              laneIndex,
              team
            });
          }
        });
      }
      game.nextWaveTick += LANE_CONFIG.WAVE_FRAMES;
    }

    if (!game.minionSpawnQueue.length) return;
    const remaining = [];
    for (const entry of game.minionSpawnQueue) {
      if (entry.due > game.tick) {
        remaining.push(entry);
        continue;
      }
      if (game.minions.length < MINION_CONFIG.MAX_COUNT) {
        spawnMinion(entry.laneIndex, entry.team);
      }
    }
    game.minionSpawnQueue = remaining;
  }

  function spawnMinion(laneIndex, team) {
    const lane = activeMap.lanes?.[laneIndex];
    if (!lane || lane.cells.length < 2) return null;

    const direction = team === "blue" ? 1 : -1;
    const startIndex = team === "blue" ? 0 : lane.cells.length - 1;
    const spawnCell = lane.cells[startIndex];
    if (!spawnCell || !isTile(spawnCell.row, spawnCell.col)) return null;

    const number = game.nextMinionId;
    game.nextMinionId += 1;
    const minion = {
      type: "minion",
      id: `minion-${number}`,
      team,
      number,
      name: `${TEAM_DEFS[team].short}兵${number}`,
      color: TEAM_DEFS[team].color,
      row: spawnCell.row,
      col: spawnCell.col,
      hp: MINION_CONFIG.HP,
      maxHp: MINION_CONFIG.HP,
      damage: MINION_CONFIG.DAMAGE,
      state: "lane",
      path: [],
      pathGoalKey: "",
      moveProgress: 0,
      anim: null,
      landedAt: null,
      laneId: laneIndex,
      laneDirection: direction,
      laneIndex: startIndex + direction,
      targetId: null,
      attackTargetId: null,
      attackPhase: null,
      attackTicks: 0,
      revealedUntil: 0,
      eyesUntil: 0
    };

    game.minions.push(minion);
    createMinionElement(minion);
    return minion;
  }

  function nearestLaneIndex(minion) {
    const lane = activeMap.lanes?.[minion.laneId];
    if (!lane || !lane.cells.length) return 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    lane.cells.forEach((cell, index) => {
      const distance = Math.abs(cell.row - minion.row) + Math.abs(cell.col - minion.col);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function tickTowers(pendingStrikes) {
    if (game.status !== "playing") return;

    for (const tower of game.towers) {
      if (tower.hp <= 0) continue;
      const current = findEntityById(tower.attackTarget);
      const candidates = allCombatants().filter(
        (entity) =>
          entity.type !== "tower" &&
          entity.team !== tower.team &&
          entity.hp > 0 &&
          isEntityVisibleTo(tower, entity) &&
          isInTowerRange(tower, entity)
      );

      if (!candidates.length) {
        tower.attackTarget = null;
        tower.attackCharge = 0;
        continue;
      }

      const minions = candidates.filter((entity) => entity.type === "minion");
      const pool = minions.length ? minions : candidates;
      let target = current;

      if (
        !target ||
        target.hp <= 0 ||
        target.type === "tower" ||
        target.team === tower.team ||
        !isInTowerRange(tower, target) ||
        !isEntityVisibleTo(tower, target) ||
        (minions.length && target.type !== "minion")
      ) {
        target = pool.sort((a, b) => {
          const distance = manhattanDistance(tower, a) - manhattanDistance(tower, b);
          if (distance !== 0) return distance;
          return a.hp - b.hp;
        })[0];
      }

      if (!target) continue;

      tower.attackTarget = target.id;
      tower.attackCharge += 1;
      if (tower.attackCharge >= TOWER_CONFIG.ATTACK_INTERVAL) {
        tower.attackCharge = 0;
        pendingStrikes.push({
          attacker: tower,
          target,
          damage: target.type === "minion" ? TOWER_CONFIG.MINION_DAMAGE : TOWER_CONFIG.HERO_DAMAGE,
          source: "tower"
        });
      }
    }
  }

  function tickMinion(minion, pendingStrikes) {
    if (game.status !== "playing" || minion.hp <= 0) return;

    if (minion.attackPhase === "windup") {
      const target = findEntityById(minion.attackTargetId);
      const targetValid =
        target &&
        target.hp > 0 &&
        isEntityVisibleTo(minion, target) &&
        isInMinionAttackRange(minion, target);

      if (!targetValid) {
        minion.attackPhase = null;
        minion.attackTicks = 0;
        minion.attackTargetId = null;
        minion.state = "idle";
        return;
      }

      minion.attackTicks -= 1;
      if (minion.attackTicks <= 0) {
        pendingStrikes.push({
          attacker: minion,
          target,
          damage: MINION_CONFIG.DAMAGE,
          source: "minion"
        });
        revealEntity(minion);
        minion.attackPhase = "backswing";
        minion.attackTicks = MINION_CONFIG.ATTACK_BACKSWING;
      }
      return;
    }

    if (minion.attackPhase === "backswing") {
      minion.attackTicks -= 1;
      if (minion.attackTicks <= 0) {
        minion.attackPhase = null;
        minion.state = "idle";
      }
      return;
    }

    const target = chooseMinionTarget(minion);
    if (!target) {
      minion.state = "lane";
      followLane(minion);
      return;
    }

    if (isInMinionAttackRange(minion, target)) {
      minion.path = [];
      minion.pathGoalKey = "";
      minion.state = "attacking";
      minion.attackTargetId = target.id;
      minion.attackPhase = "windup";
      minion.attackTicks = MINION_CONFIG.ATTACK_WINDUP;
      revealEntity(minion);
      return;
    }

    const goal = minionApproachGoal(minion, target);
    if (goal) moveMinionToward(minion, goal);
    else minion.state = "idle";
  }

  function chooseMinionTarget(minion) {
    const leash = (entity) =>
      entity &&
      entity.hp > 0 &&
      entity.team !== minion.team &&
      isEntityVisibleTo(minion, entity) &&
      chebyshevDistance(minion, entity) <= MINION_CONFIG.LEASH_RANGE;

    let current = minion.targetId ? findEntityById(minion.targetId) : null;
    if (!leash(current)) current = null;

    if (!current) {
      const candidates = allCombatants().filter(
        (entity) =>
          entity.hp > 0 &&
          entity.team !== minion.team &&
          isEntityVisibleTo(minion, entity) &&
          chebyshevDistance(minion, entity) <= MINION_CONFIG.DETECT_RANGE
      );

      candidates.sort((a, b) => {
        const distance = manhattanDistance(minion, a) - manhattanDistance(minion, b);
        if (distance !== 0) return distance;
        return a.hp - b.hp;
      });
      current = candidates[0] || null;
    }

    const previous = minion.targetId;
    minion.targetId = current ? current.id : null;
    if (!current) {
      if (previous) {
        minion.laneIndex = nearestLaneIndex(minion);
      }
      return null;
    }

    return current;
  }

  function minionApproachGoal(minion, target) {
    if (target.type !== "minion") {
      return { row: target.row, col: target.col };
    }

    const options = [
      [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]
    ]
      .map(([dr, dc]) => ({ row: target.row + dr, col: target.col + dc }))
      .filter(
        (cell) =>
          isTile(cell.row, cell.col) &&
          !isOccupied(cell.row, cell.col, minion.id, minion)
      )
      .sort(
        (a, b) =>
          manhattanDistance(minion, a) - manhattanDistance(minion, b)
      );

    return options[0] || null;
  }

  function moveMinionToward(minion, goal) {
    if (!goal) return false;
    if (minion.row === goal.row && minion.col === goal.col) {
      minion.path = [];
      minion.pathGoalKey = "";
      minion.state = "idle";
      return true;
    }

    const goalKey = cellKey(goal.row, goal.col);
    if (!minion.path.length || minion.pathGoalKey !== goalKey) {
      const path = findPathFrom(
        minion.row,
        minion.col,
        goal.row,
        goal.col,
        minion.id,
        minion
      );
      if (!path || !path.length) {
        minion.path = [];
        minion.pathGoalKey = "";
        minion.state = "idle";
        return false;
      }
      minion.path = path;
      minion.pathGoalKey = goalKey;
      minion.moveProgress = 0;
      minion.anim = null;
      minion.landedAt = null;
      startCellAnimation(minion, MINION_CONFIG.MOVE_TICKS * CONFIG.TICK_MS);
    }

    if (!minion.path.length) return false;
    minion.state = "moving";
    minion.moveProgress += 1;

    if (minion.moveProgress >= MINION_CONFIG.MOVE_TICKS) {
      const next = minion.path[0];
      if (!next || isOccupied(next.row, next.col, minion.id, minion)) {
        minion.path = [];
        minion.pathGoalKey = "";
        minion.moveProgress = 0;
        minion.anim = null;
        minion.state = "idle";
        return false;
      }

      minion.path.shift();
      minion.row = next.row;
      minion.col = next.col;
      minion.moveProgress = 0;

      if (minion.path.length) {
        startCellAnimation(minion, MINION_CONFIG.MOVE_TICKS * CONFIG.TICK_MS);
      } else {
        minion.anim = null;
        minion.landedAt = null;
        minion.state = "idle";
      }
    }

    return true;
  }

  function followLane(minion) {
    const lane = activeMap.lanes?.[minion.laneId];
    if (!lane || lane.cells.length < 2) {
      minion.state = "idle";
      return;
    }

    if (!Number.isInteger(minion.laneIndex)) {
      minion.laneIndex = nearestLaneIndex(minion);
    }

    const direction = minion.laneDirection || (minion.team === "blue" ? 1 : -1);

    while (
      minion.laneIndex >= 0 &&
      minion.laneIndex < lane.cells.length &&
      minion.row === lane.cells[minion.laneIndex].row &&
      minion.col === lane.cells[minion.laneIndex].col
    ) {
      minion.laneIndex += direction;
    }

    if (minion.laneIndex < 0 || minion.laneIndex >= lane.cells.length) {
      minion.state = "idle";
      return;
    }

    moveMinionToward(minion, lane.cells[minion.laneIndex]);
  }

  function tickCast(piece) {
    const cast = piece.cast;
    if (!cast) {
      piece.state = "idle";
      return;
    }

    cast.ticks += 1;
    const shock = SKILL_LIBRARY.shock;

    if (cast.phase === "windup") {
      if (cast.ticks >= shock.windup) {
        resolveSkill2(piece, cast);
        if (game.status !== "playing") return;
        cast.phase = "backswing";
        cast.ticks = 0;
      }
      return;
    }

    if (cast.phase === "backswing" && cast.ticks >= shock.backswing) {
      piece.cast = null;
      piece.state = "idle";
    }
  }

  function resolveSkill2(caster, cast) {
    const area = cast.area || areaForDirection(cast.origin.row, cast.origin.col, cast.direction);
    const targets = allCombatants().filter(
      (target) =>
        target.team !== caster.team &&
        target.hp > 0 &&
        area.some((cell) => cell.row === target.row && cell.col === target.col)
    );

    showSkillBlast(area);
    els.board.classList.remove("is-shaking");
    void els.board.offsetWidth;
    els.board.classList.add("is-shaking");
    later(() => els.board.classList.remove("is-shaking"), 700);

    if (!targets.length) {
      addLog("技能", "skill", `${caster.name} 震域落空。`);
      return;
    }

    revealEntity(caster);
    const names = targets.map((target) => target.name).join("、");
    addLog(
      "技能",
      "skill",
      `${caster.name} 震域命中 ${names} · ${SKILL_LIBRARY.shock.damage} 点伤害。`
    );

    for (const target of targets) {
      applyDamage(target, SKILL_LIBRARY.shock.damage, caster);
    }
  }

  function applyDamage(target, amount, attacker) {
    if (!target || target.hp <= 0) return false;

    target.hp = Math.max(0, target.hp - amount);
    if (attacker) revealEntity(attacker);
    showHitFlash(target);

    if (target.hp <= 0) {
      markDefeated(target);
      return true;
    }

    return false;
  }

  function showHitFlash(target) {
    const root = entityRoot(target);
    if (!root) return;
    root.classList.remove("is-hit");
    root.classList.add("is-hit");
    later(() => root.classList.remove("is-hit"), 500);
  }

  function beginAttack(attacker, target, cause = "move") {
    const resumedDestination = attacker.destination
      ? { row: attacker.destination.row, col: attacker.destination.col }
      : null;

    revealEntity(attacker);
    attacker.state = "attacking";
    attacker.attackTarget = target.id;
    attacker.attackCharge = 0;
    attacker.path = [];
    attacker.destination = null;
    attacker.reroute = null;
    attacker.attackResume = resumedDestination;
    attacker.moveProgress = 0;
    attacker.recoveryTicks = 0;
    attacker.anim = null;
    attacker.landedAt = null;

    if (cause === "guard") {
      addLog(
        "警戒",
        "attack",
        `${attacker.name} 守株待兔，锁定踏入范围的 ${target.name}。`
      );
    } else {
      addLog(
        "攻击",
        "attack",
        `${attacker.name} 停下迎敌，锁定 ${target.name}。`
      );
    }
  }

  function stopAttack(piece) {
    if (piece.state !== "attacking") return;

    piece.state = "idle";
    piece.attackTarget = null;
    piece.attackCharge = 0;

    const resume = piece.attackResume;
    piece.attackResume = null;

    if (resume) {
      const path = findPathFrom(piece.row, piece.col, resume.row, resume.col, piece.id, piece);
      if (path && path.length) {
        piece.path = path;
        piece.destination = { row: resume.row, col: resume.col };
        piece.state = "moving";
        piece.moveProgress = 0;
        startCellAnimation(piece);
        return;
      }
    }

    piece.path = [];
    piece.destination = null;
  }

  function abortMove(piece, message) {
    piece.path = [];
    piece.destination = null;
    piece.reroute = null;
    piece.aiMove = false;
    piece.state = "idle";
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.anim = null;
    piece.landedAt = null;
    addLog("中止", "system", `${piece.name}：${message}`);
    showToast(message);
    syncAll();
  }

  function stopAIMoveSilently(piece) {
    piece.path = [];
    piece.destination = null;
    piece.reroute = null;
    piece.aiMove = false;
    piece.trackMove = false;
    piece.state = "idle";
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.anim = null;
    piece.landedAt = null;
  }

  function clearUnitAction(piece) {
    piece.path = [];
    piece.destination = null;
    piece.reroute = null;
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.attackTarget = null;
    piece.attackCharge = 0;
    piece.attackResume = null;
    piece.anim = null;
    piece.landedAt = null;
  }

  function handleSkillSelect(skill) {
    if (game.status !== "playing" || els.helpDialog.open) return;

    const piece = selectedPiece();
    if (!piece) {
      showToast("请先选择英雄。");
      return;
    }
    if (!piece.skills) {
      showToast("该英雄没有技能。");
      return;
    }
    if (piece.hp <= 0) return;

    const slot = piece.skills[skill];
    if (!slot) {
      showToast(`技能${skill}不存在。`);
      return;
    }
    const def = SKILL_LIBRARY[slot.id];

    if (piece.aim && piece.aim.skill === skill) {
      cancelAim(piece, false);
      return;
    }

    if (slot.cooldown > 0) {
      showToast(`${def.name}冷却中 · ${formatCooldown(slot.cooldown)}`);
      return;
    }

    if (def.id === "heal") {
      castHeal(piece, false);
      return;
    }
    if (def.id === "empower") {
      activateEmpower(piece);
      return;
    }

    if (skill === 2 && piece.cast) {
      showToast(
        piece.cast.phase === "windup" ? "震域正在前摇。" : "震域正在后摇。"
      );
      return;
    }

    piece.aim = {
      skill,
      direction: def.id === "shock" ? nearestEnemyDirection(piece) : null
    };
    piece.lastCommandTick = game.tick;
    game.hoverPlan = null;
    syncAll(true);
  }

  function cancelAim(piece, silent = true) {
    if (!piece || !piece.aim) return;
    piece.aim = null;
    if (!silent) showToast("已取消技能选择。");
    syncAll(true);
  }

  function castAimedDirection(key) {
    const hero = selectedHero();
    if (!hero || !hero.aim) return;

    const direction = DIRECTIONS_BY_KEY[key];
    if (!direction) return;

    const slot = hero.skills[hero.aim.skill];
    if (!slot) return;

    if (slot.id === "shock") startSkill2(hero, direction);
    else if (slot.id === "blink") performBlink(hero, direction);
  }

  function startSkill2(hero, direction) {
    if (!hero || !hero.skills || hero.hp <= 0 || game.status !== "playing") return false;

    const slot = hero.skills[2];
    if (!slot || slot.id !== "shock") {
      showToast("该英雄没有震域。");
      return false;
    }
    if (hero.state === "casting") {
      showToast("技能施放中。");
      return false;
    }

    if (slot.cooldown > 0) {
      showToast(`震域冷却中 · ${formatCooldown(slot.cooldown)}`);
      return false;
    }

    const dir = normalizeCardinalDirection(direction || nearestEnemyDirection(hero));
    const origin = { row: hero.row, col: hero.col };

    slot.cooldown = SKILL_LIBRARY.shock.cooldown;
    hero.aim = null;
    hero.lastCommandTick = game.tick;
    clearUnitAction(hero);
    revealEntity(hero);
    hero.state = "casting";
    hero.cast = {
      id: "shock",
      skill: 2,
      phase: "windup",
      ticks: 0,
      origin,
      direction: { dr: dir.dr, dc: dir.dc, label: directionLabel(dir.dr, dir.dc) },
      area: areaForDirection(origin.row, origin.col, dir)
    };

    game.hoverPlan = null;
    addLog(
      "技能",
      "skill",
      `${hero.name} 发动震域 · 朝${directionLabel(dir.dr, dir.dc)} · 前摇 ${SKILL_LIBRARY.shock.windup} 帧。`
    );
    syncAll(true);
    return true;
  }

  function performBlink(hero, direction) {
    if (!hero || !hero.skills || hero.hp <= 0 || game.status !== "playing") return false;

    const slot = hero.skills[1];
    if (!slot || slot.id !== "blink") {
      showToast("该英雄没有折跃。");
      return false;
    }
    if (slot.cooldown > 0) {
      showToast(`折跃冷却中 · ${formatCooldown(slot.cooldown)}`);
      return false;
    }

    const targetRow = hero.row + direction.dr * 2;
    const targetCol = hero.col + direction.dc * 2;
    if (!inBounds(targetRow, targetCol) || isOccupied(targetRow, targetCol, hero.id, hero)) {
      showToast("折跃落点无效。");
      return false;
    }

    const activeWindup = Boolean(
      hero.cast && hero.cast.id === "shock" && hero.cast.phase === "windup"
    );
    const from = { row: hero.row, col: hero.col };

    slot.cooldown = SKILL_LIBRARY.blink.cooldown;
    hero.aim = null;
    hero.lastCommandTick = game.tick;
    clearUnitAction(hero);
    hero.row = targetRow;
    hero.col = targetCol;

    if (activeWindup) {
      hero.cast.origin = { row: targetRow, col: targetCol };
      hero.cast.direction = {
        dr: direction.dr,
        dc: direction.dc,
        label: directionLabel(direction.dr, direction.dc)
      };
      hero.cast.area = areaForDirection(
        hero.cast.origin.row,
        hero.cast.origin.col,
        direction
      );
      addLog(
        "技能",
        "skill",
        `${hero.name} 折跃 · 震域以折跃后的 ${cellLabel(hero.cast.origin.row, hero.cast.origin.col)} 为起点，朝${directionLabel(direction.dr, direction.dc)}。`
      );
    } else {
      hero.cast = null;
      hero.state = "idle";
      addLog(
        "技能",
        "skill",
        `${hero.name} 折跃两格 → ${cellLabel(targetRow, targetCol)}。`
      );
    }

    showBlinkEffect(from.row, from.col, targetRow, targetCol, hero.color);
    game.hoverPlan = null;
    renderPieces();
    syncAll(true);
    return true;
  }

  function activateEmpower(hero) {
    const slot = hero?.skills?.[2];
    if (!slot || slot.id !== "empower") return false;
    if (slot.cooldown > 0) {
      showToast(`强化普攻冷却中 · ${formatCooldown(slot.cooldown)}`);
      return false;
    }

    slot.cooldown = SKILL_LIBRARY.empower.cooldown;
    hero.empowerCharges = SKILL_LIBRARY.empower.charges;
    hero.aim = null;
    hero.lastCommandTick = game.tick;
    revealEntity(hero);
    addLog("技能", "skill", `${hero.name} 强化普攻 · 下三次普攻伤害 3。`);
    syncAll(true);
    return true;
  }

  function healTargetsFor(hero) {
    const targets = allUnits().filter(
      (piece) =>
        piece.team === hero.team &&
        piece.hp > 0 &&
        Math.max(Math.abs(piece.row - hero.row), Math.abs(piece.col - hero.col)) <= 2
    );
    targets.sort((a, b) => a.hp - b.hp);
    return targets;
  }

  function castHeal(hero, autonomous = false) {
    const slot = hero?.skills?.[1];
    if (!slot || slot.id !== "heal") return false;
    if (slot.cooldown > 0) {
      if (!autonomous) showToast(`复苏冷却中 · ${formatCooldown(slot.cooldown)}`);
      return false;
    }

    const candidates = healTargetsFor(hero);
    if (!candidates.length) return false;
    const lowest = candidates[0];
    const targets = lowest.id === hero.id ? [hero] : [hero, lowest];
    const ratio = autonomous ? 0.1 : 0.2;
    let healed = 0;

    for (const target of targets) {
      const amount = Math.min(
        target.maxHp - target.hp,
        Math.ceil(target.maxHp * ratio)
      );
      if (amount <= 0) continue;
      target.hp += amount;
      healed += amount;
    }

    slot.cooldown = SKILL_LIBRARY.heal.cooldown;
    hero.aim = null;
    if (!autonomous) hero.lastCommandTick = game.tick;
    revealEntity(hero);
    addLog(
      "技能",
      "skill",
      `${hero.name} 复苏 · ${targets.map((target) => target.name).join("、")} 恢复 ${healed} HP${autonomous ? "（自主减半）" : ""}。`
    );
    if (!autonomous) showToast(`${hero.name} 发动复苏。`);
    syncAll(true);
    return true;
  }

  function tryAutoHeal(hero) {
    const slot = hero?.skills?.[1];
    if (!slot || slot.id !== "heal" || slot.cooldown > 0 || hero.hp <= 0) return false;
    const low = healTargetsFor(hero).some((piece) => piece.hp / piece.maxHp < 0.5);
    return low ? castHeal(hero, true) : false;
  }

  function resolveStrikes(strikes) {
    for (const strike of strikes) {
      const attacker = strike.attacker;
      const target = strike.target;
      if (!attacker || !target || target.hp <= 0) continue;

      const damage = strike.damage ?? attacker.damage;
      spawnStrikeEffect(attacker, target);
      applyDamage(target, damage, attacker);

      if (
        target.type === "hero" ||
        attacker.type === "hero" ||
        target.type === "tower"
      ) {
        addLog(
          "命中",
          "attack",
          `${attacker.name} 命中 ${target.name} · ${target.hp}/${target.maxHp} HP。`
        );
      }
    }
  }

  function markDefeated(target) {
    if (!target || target.hp > 0) return;

    if (target.type === "minion") {
      game.minions = game.minions.filter((minion) => minion.id !== target.id);
      if (minionEls[target.id]) {
        minionEls[target.id].root.remove();
        delete minionEls[target.id];
      }
      addLog("击破", "kill", `${target.name} 被击败。`);
      return;
    }

    if (target.type === "tower") {
      const wasCrystal = target.isCrystal;
      game.towers = game.towers.filter((tower) => tower.id !== target.id);
      if (towerEls[target.id]) {
        towerEls[target.id].root.remove();
        delete towerEls[target.id];
      }
      addLog("摧毁", "kill", `${target.name} 被摧毁。`);
      if (wasCrystal) endByCrystal(target);
      return;
    }

    target.state = "defeated";
    target.path = [];
    target.destination = null;
    target.reroute = null;
    target.attackResume = null;
    target.attackTarget = null;
    target.attackCharge = 0;
    target.moveProgress = 0;
    target.recoveryTicks = 0;
    target.anim = null;
    target.landedAt = null;
    target.aim = null;
    target.cast = null;
    target.empowerCharges = 0;
    target.queuedAttack = false;
    target.trackMove = false;
    target.manualTargetId = null;
    target.manualTargetLast = null;
    target.aiMove = false;
    target.respawnTotal = respawnTicksForTime(game.gameMs);
    target.respawnTicks = target.respawnTotal;

    if (game.markedTargetId === target.id) game.markedTargetId = null;
    if (focusState.active && focusState.heroId === target.id) {
      exitFocusMode(true);
      showToast(`${target.name} 阵亡，已退出专注模式。`);
    }

    if (game.selected === target.id) {
      game.selected = null;
      game.hoverPlan = null;
      clearRoute();
    }

    addLog(
      "击破",
      "kill",
      `${target.name} 被击败 · ${(target.respawnTotal / 10).toFixed(1)} 秒后复活。`
    );
  }

  function endByCrystal(tower) {
    const winner = tower.team === "red" ? "blue" : "red";
    game.endReason = "crystal";
    finishMatch(winner);
  }

  function finishMatch(winner = null) {
    if (game.status !== "playing") return;

    game.winner = winner || game.winner || "draw";
    game.status = "over";
    exitFocusMode(true);
    rallyArmed = false;
    document.body.classList.remove("is-rallying");
    game.selected = null;
    game.hoverPlan = null;
    hoverCell = null;
    clearHoverVisuals();

    for (const piece of allUnits()) {
      piece.path = [];
      piece.destination = null;
      piece.reroute = null;
      piece.attackResume = null;
      piece.attackTarget = null;
      piece.attackCharge = 0;
      piece.moveProgress = 0;
      piece.recoveryTicks = 0;
      piece.aim = null;
      piece.cast = null;
      if (piece.hp > 0) piece.state = "idle";
    }

    for (const minion of game.minions) {
      minion.path = [];
      minion.pathGoalKey = "";
      minion.attackPhase = null;
      minion.attackTicks = 0;
      minion.targetId = null;
      minion.attackTargetId = null;
      minion.moveProgress = 0;
      minion.anim = null;
      minion.state = "idle";
    }

    for (const tower of game.towers) {
      tower.attackTarget = null;
      tower.attackCharge = 0;
    }

    if (game.winner === "draw") {
      addLog("终局", "system", "双方水晶同时被摧毁 · 平局。");
    } else {
      const loser = game.winner === "red" ? "blue" : "red";
      addLog(
        "终局",
        "system",
        `${TEAM_DEFS[game.winner].name} 获胜 · ${TEAM_DEFS[loser].name}水晶被摧毁。`
      );
    }

    syncAll(true);
    later(showResult, 850);
  }

  /* ---------------------------------------------------------
     Move / reroute plans
     --------------------------------------------------------- */

  function makeMovePlan(piece, targetRow, targetCol) {
    if (!inBounds(targetRow, targetCol)) return null;
    if (piece.hp <= 0 || game.status !== "playing") return null;
    if (isOccupied(targetRow, targetCol, piece.id, piece)) return null;

    if (piece.state === "idle" || piece.state === "recovering") {
      const path = findPathFrom(piece.row, piece.col, targetRow, targetCol, piece.id, piece);
      if (!path) return null;

      const current = { row: piece.row, col: piece.col };
      const baseDelay = piece.state === "recovering" ? piece.recoveryTicks : 0;
      const engageIndex = firstThreatIndex(piece, path);
      const shownPath = engageIndex >= 0 ? path.slice(0, engageIndex + 1) : path;

      return {
        kind: piece.state,
        target: { row: targetRow, col: targetCol },
        path,
        after: path,
        points: [current, ...shownPath],
        cellCount: shownPath.length,
        ticks: baseDelay + routeTicks(shownPath.length),
        engagement: engageIndex >= 0
      };
    }

    if (piece.state === "moving") {
      if (!piece.path.length) return null;
      const next = piece.path[0];
      const path = findPathFrom(next.row, next.col, targetRow, targetCol, piece.id, piece);
      if (!path) return null;

      const current = { row: piece.row, col: piece.col };
      let shownPath = path;
      let cellCount = 1 + path.length;
      let ticks = CONFIG.MOVE_STEP_TICKS - piece.moveProgress;
      let engagement = false;

      if (path.length) {
        ticks += CONFIG.MOVE_RECOVERY_TICKS + routeTicks(path.length);
      }

      if (cellIsThreatened(piece, next.row, next.col)) {
        shownPath = [];
        cellCount = 1;
        ticks = CONFIG.MOVE_STEP_TICKS - piece.moveProgress;
        engagement = true;
      } else if (path.length) {
        const engageIndex = firstThreatIndex(piece, path);
        if (engageIndex >= 0) {
          shownPath = path.slice(0, engageIndex + 1);
          cellCount = 1 + shownPath.length;
          ticks = CONFIG.MOVE_STEP_TICKS - piece.moveProgress +
            CONFIG.MOVE_RECOVERY_TICKS + routeTicks(shownPath.length);
          engagement = true;
        }
      }

      return {
        kind: "moving",
        target: { row: targetRow, col: targetCol },
        path,
        after: path,
        points: [current, next, ...shownPath],
        cellCount,
        ticks,
        engagement
      };
    }

    return null;
  }

  function cellIsThreatened(piece, row, col) {
    for (const other of allUnits()) {
      if (other.team === piece.team || other.hp <= 0) continue;
      if (
        Math.max(Math.abs(row - other.row), Math.abs(col - other.col)) === 1
      ) {
        return true;
      }
    }
    return false;
  }

  function firstThreatIndex(piece, path) {
    return path.findIndex((step) => cellIsThreatened(piece, step.row, step.col));
  }

  function issueMove(piece, plan) {
    if (!plan || !plan.path || !plan.path.length) {
      showToast("无法到达该位置。");
      return;
    }

    piece.path = plan.path.map((step) => ({ row: step.row, col: step.col }));
    piece.destination = { row: plan.target.row, col: plan.target.col };
    piece.state = "moving";
    piece.moveProgress = 0;
    piece.recoveryTicks = 0;
    piece.attackTarget = null;
    piece.attackCharge = 0;
    piece.attackResume = null;
    piece.reroute = null;
    piece.aiMove = false;
    piece.anim = null;
    piece.landedAt = null;

    if (game.selected !== piece.id) game.selected = piece.id;
    game.hoverPlan = null;

    if (!chooseAttackTarget(piece)) {
      startCellAnimation(piece);
    }

    addLog(
      "移动",
      "move",
      `${piece.name} → ${cellLabel(plan.target.row, plan.target.col)} · ${plan.path.length} 格。`
    );

    piece.aim = null;
    piece.lastCommandTick = game.tick;
    piece.aiMove = false;
    piece.trackMove = false;
    piece.manualTargetId = null;
    piece.manualTargetLast = null;
    piece.aiLaneMode = "nearest";
    piece.queuedAttack = false;
    game.markedTargetId = null;
    game.rallyPoint = null;
    game.selected = null;
    game.hoverPlan = null;
    syncAll(true);
  }

  function applyReroute(piece, plan) {
    if (!plan) {
      showToast("无法变道到该位置。");
      return;
    }
    piece.lastCommandTick = game.tick;
    piece.aiMove = false;
    piece.trackMove = false;
    piece.manualTargetId = null;
    piece.manualTargetLast = null;
    piece.aiLaneMode = "nearest";
    piece.queuedAttack = false;
    game.markedTargetId = null;
    game.rallyPoint = null;

    if (piece.state === "recovering") {
      if (!plan.path || !plan.path.length) {
        showToast("无法到达该位置。");
        return;
      }

      piece.path = plan.path.map((step) => ({ row: step.row, col: step.col }));
      piece.destination = { row: plan.target.row, col: plan.target.col };
      piece.reroute = null;
      game.hoverPlan = null;

      addLog(
        "变道",
        "move",
        `${piece.name} 变道 → ${cellLabel(plan.target.row, plan.target.col)} · ${plan.path.length} 格。`
      );
      piece.aim = null;
      game.selected = null;
      game.hoverPlan = null;
      syncAll(true);
      return;
    }

    if (piece.state === "moving") {
      piece.reroute = {
        target: { row: plan.target.row, col: plan.target.col },
        path: plan.path.map((step) => ({ row: step.row, col: step.col }))
      };
      piece.destination = { row: plan.target.row, col: plan.target.col };
      game.hoverPlan = null;

      addLog(
        "变道",
        "move",
        `${piece.name} 将在下一格变道 → ${cellLabel(plan.target.row, plan.target.col)}。`
      );
      piece.aim = null;
      game.selected = null;
      game.hoverPlan = null;
      syncAll(true);
    }
  }

  /* ---------------------------------------------------------
     UI
     --------------------------------------------------------- */

  function syncAll(force = false) {
    syncUnitElements();
    syncTowers();
    syncMinions();
    syncFog();
    syncTargetMarker();
    syncFocusUI();
    syncRosters();
    syncInstruction();
    syncSteps();
    syncStats();
    syncSelectedLine();
    syncSkillDock();
    syncClock();
    syncRange(force);
    syncSkillLayer(force);
    syncRoute(force);
  }

  function syncFog() {
    if (!game || !fogCells.length) return;
    if (editor.active) return;
    const visible = visibleCellsForView();
    for (let row = 0; row < CONFIG.SIZE; row += 1) {
      for (let col = 0; col < CONFIG.SIZE; col += 1) {
        const cell = fogCells[row]?.[col];
        if (cell) cell.classList.toggle("is-visible", visible.has(cellKey(row, col)));
      }
    }
  }

  function syncTargetMarker() {
    if (!els.targetMark || !game) return;
    let target = game.markedTargetId ? findEntityById(game.markedTargetId) : null;
    if (target && (target.hp <= 0 || !isEntityVisibleToViewTeam(target))) target = null;
    const rally = !target && game.rallyPoint ? game.rallyPoint : null;
    if (!target && !rally) {
      els.targetMark.classList.remove("is-visible", "is-rally");
      return;
    }
    const row = target ? target.row : rally.row;
    const col = target ? target.col : rally.col;
    els.targetMark.style.left = `${pos(col)}%`;
    els.targetMark.style.top = `${pos(row)}%`;
    els.targetMark.classList.toggle("is-rally", Boolean(rally));
    els.targetMark.classList.add("is-visible");
  }

  function syncFocusUI() {
    if (!els.focusHud || !game) return;
    const hero = focusedHero();
    if (focusState.active && !hero) {
      exitFocusMode(true);
      return;
    }
    els.focusHud.hidden = !focusState.active;
    els.focusFrame.classList.toggle("is-visible", Boolean(focusState.active && hero));
    document.body.classList.toggle("is-focused", Boolean(focusState.active));
    if (!focusState.active || !hero) return;

    els.focusName.textContent = hero.name;
    els.focusTeam.textContent = `${TEAM_DEFS[hero.team].name}视角`;
    updateFocusCamera(hero);

    const left = BOARD_MARGIN + (hero.col - 3) * CELL_SIZE;
    const top = BOARD_MARGIN + (hero.row - 3) * CELL_SIZE;
    const size = 7 * CELL_SIZE;
    els.focusFrame.style.left = `${left}%`;
    els.focusFrame.style.top = `${top}%`;
    els.focusFrame.style.width = `${size}%`;
    els.focusFrame.style.height = `${size}%`;

    renderMinimap(hero);
  }

  function updateFocusCamera(hero) {
    if (!els.board || !hero) return;
    const boardSize = els.board.clientWidth;
    if (!boardSize) return;
    const visibleFraction = (7 * CELL_SIZE) / 100;
    const scale = 1 / visibleFraction;
    const centerX = (pos(hero.col) / 100) * boardSize;
    const centerY = (pos(hero.row) / 100) * boardSize;
    const translateX = boardSize / 2 - centerX * scale;
    const translateY = boardSize / 2 - centerY * scale;
    els.board.style.transform =
      `translate3d(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px, 0) scale(${scale.toFixed(5)})`;
  }

  function renderMinimap(hero) {
    if (!minimapCtx || !game) return;
    const ctx = minimapCtx;
    const width = els.minimap.width;
    const cell = width / CONFIG.SIZE;
    ctx.clearRect(0, 0, width, width);
    ctx.fillStyle = "#07100b";
    ctx.fillRect(0, 0, width, width);

    for (let row = 0; row < CONFIG.SIZE; row += 1) {
      for (let col = 0; col < CONFIG.SIZE; col += 1) {
        const x = col * cell;
        const y = row * cell;
        if (!isTile(row, col)) {
          ctx.fillStyle = "rgba(0,0,0,0.36)";
          ctx.fillRect(x, y, cell + 0.4, cell + 0.4);
          continue;
        }
        ctx.fillStyle = isCellVisibleToViewTeam(row, col) ? "#13251b" : "#0a1510";
        ctx.fillRect(x, y, cell + 0.4, cell + 0.4);
        if (grassPatchAt(row, col)) {
          ctx.fillStyle = "rgba(58, 111, 76, 0.58)";
          ctx.fillRect(x, y, cell + 0.4, cell + 0.4);
        }
      }
    }

    for (const key of activeMap.walls) {
      const [axis, rowText, colText] = key.split(":");
      const row = Number(rowText);
      const col = Number(colText);
      ctx.strokeStyle = "rgba(217, 190, 141, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (axis === "h") {
        ctx.moveTo(col * cell, row * cell);
        ctx.lineTo((col + 1) * cell, row * cell);
      } else {
        ctx.moveTo(col * cell, row * cell);
        ctx.lineTo(col * cell, (row + 1) * cell);
      }
      ctx.stroke();
    }

    for (const tower of game.towers) {
      const x = (tower.col + 0.5) * cell;
      const y = (tower.row + 0.5) * cell;
      ctx.beginPath();
      ctx.fillStyle = tower.isCrystal
        ? "#f4d184"
        : tower.team === "red" ? "rgba(240,99,86,0.9)" : "rgba(103,173,245,0.9)";
      ctx.arc(x, y, tower.isCrystal ? 6.2 : 4.4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const minion of game.minions) {
      if (!isEntityVisibleToViewTeam(minion)) continue;
      const x = (minion.col + 0.5) * cell;
      const y = (minion.row + 0.5) * cell;
      ctx.beginPath();
      ctx.fillStyle = minion.team === "red" ? "rgba(240,99,86,0.78)" : "rgba(103,173,245,0.78)";
      ctx.arc(x, y, 3.0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const piece of allUnits()) {
      if (piece.hp <= 0 || !isEntityVisibleToViewTeam(piece)) continue;
      const x = (piece.col + 0.5) * cell;
      const y = (piece.row + 0.5) * cell;
      ctx.beginPath();
      ctx.fillStyle = piece.team === "red" ? "#ff7d70" : "#81bdff";
      ctx.arc(x, y, 9.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,248,224,0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const view = 7 * cell;
    ctx.strokeStyle = "rgba(255,222,145,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      (hero.col - 3) * cell,
      (hero.row - 3) * cell,
      view,
      view
    );
  }

  function syncUnitElements() {
    const targetIds = new Set(
      allUnits()
        .filter((piece) => piece.state === "attacking" && piece.attackTarget)
        .map((piece) => piece.attackTarget)
    );

    for (const piece of allUnits()) {
      const element = pieceEls[piece.id];
      const team = TEAM_DEFS[piece.team];
      const defeated = piece.hp <= 0;
      const visible = isEntityVisibleToViewTeam(piece);
      element.root.classList.toggle("is-fogged", !visible);

      element.root.classList.toggle("is-selected", game.selected === piece.id);
      element.root.classList.toggle("is-defeated", defeated);
      element.root.classList.toggle("is-hero", piece.isHero);
      element.root.classList.toggle("is-targeted", targetIds.has(piece.id));
      element.root.classList.toggle("is-in-grass", isEntityInGrass(piece));
      element.root.classList.toggle("is-exposed", isEntityExposed(piece));
      if (element.eye) element.eye.classList.toggle("is-visible", isEntityExposed(piece));
      element.root.setAttribute(
        "aria-label",
        `${team.name} ${piece.name}，位于 ${cellLabel(piece.row, piece.col)}，生命 ${piece.hp} / ${piece.maxHp}`
      );

      element.hpFill.style.width = `${(piece.hp / piece.maxHp) * 100}%`;

      let timerText = "";
      if (defeated && piece.respawnTicks > 0) {
        timerText = `复活 ${(piece.respawnTicks / 10).toFixed(0)}s`;
      } else if (!defeated && piece.state === "recovering") {
        timerText = `${piece.recoveryTicks}F`;
      } else if (!defeated && piece.state === "attacking") {
        timerText = `${Math.max(1, CONFIG.ATTACK_INTERVAL_TICKS - piece.attackCharge)}F`;
      } else if (!defeated && piece.state === "casting" && piece.cast) {
        timerText = piece.cast.phase === "windup"
          ? `前${Math.max(0, SKILL_LIBRARY.shock.windup - piece.cast.ticks)}F`
          : `后${Math.max(0, SKILL_LIBRARY.shock.backswing - piece.cast.ticks)}F`;
      }

      element.timer.textContent = timerText;
      element.timer.classList.toggle("is-visible", Boolean(timerText));
    }
  }

  function unitStateShort(piece) {
    if (piece.hp <= 0) {
      return piece.respawnTicks > 0
        ? `复活 ${Math.ceil(piece.respawnTicks / 10)}s`
        : "阵亡";
    }
    if (piece.cast) return piece.cast.phase === "windup" ? "前摇" : "后摇";
    if (piece.aim) return "瞄准";
    if (piece.state === "attacking") return "攻击";
    if (piece.state === "recovering") return "后摇";
    if (piece.state === "moving") return "移动";
    return "待命";
  }

  function syncRosters() {
    for (const piece of allUnits()) {
      const element = unitEls[piece.id];
      if (!element) continue;
      const visible = isEntityVisibleToViewTeam(piece);

      element.root.classList.toggle("is-selected", game.selected === piece.id);
      element.root.classList.toggle("is-defeated", piece.hp <= 0);
      element.root.classList.toggle("is-fogged", !visible);
      element.root.disabled = game.status !== "playing" || piece.hp <= 0 || !visible || piece.team !== viewTeam;
      element.root.setAttribute(
        "aria-label",
        `${TEAM_DEFS[piece.team].name} ${piece.name}，生命 ${piece.hp}/${piece.maxHp}，${unitStateShort(piece)}`
      );

      element.pips.forEach((pip, index) => {
        pip.classList.toggle("is-empty", index >= piece.hp);
      });

      element.state.textContent = visible ? unitStateShort(piece) : "视野外";
    }

    const redAlive = livingUnits("red").length;
    const blueAlive = livingUnits("blue").length;
    els.aliveRed.textContent = String(redAlive);
    els.aliveBlue.textContent = String(blueAlive);
    els.teamRed.classList.toggle("is-wiped", redAlive === 0);
    els.teamBlue.classList.toggle("is-wiped", blueAlive === 0);
  }

  const SKILL_ICONS = {
    blink: '<path d="M5 19 17 7M11 7h6v6M5 13v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    shock: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 6v12M14.5 6v12M6 9.5h12M6 14.5h12" fill="none" stroke="currentColor" stroke-width=".8" opacity=".7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
    empower: '<path d="M12 3v10M8 9l4 4 4-4M5 16v4h14v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    heal: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };

  function syncSkillDock() {
    const hero = game.status === "playing" ? selectedHero() : null;
    els.skillDock.hidden = !hero;

    if (!hero) {
      els.skillDpad.hidden = true;
      els.skillBtn2.hidden = true;
      return;
    }

    els.skillDock.classList.toggle("skill-dock--red", hero.team === "red");
    els.skillDock.classList.toggle("skill-dock--blue", hero.team === "blue");
    els.skillDock.classList.toggle("is-aiming", Boolean(hero.aim));
    els.skillOwner.textContent = hero.name;

    for (const slot of [1, 2]) {
      const button = slot === 1 ? els.skillBtn1 : els.skillBtn2;
      const cdLabel = slot === 1 ? els.skill1Cd : els.skill2Cd;
      const shade = slot === 1 ? els.skill1Shade : els.skill2Shade;
      const skill = hero.skills?.[slot];
      if (!skill) {
        button.hidden = true;
        continue;
      }

      button.hidden = false;
      const def = SKILL_LIBRARY[skill.id];
      const cooldown = skill.cooldown;
      const isCooling = cooldown > 0;
      const isAiming = hero.aim && hero.aim.skill === slot;

      button.classList.toggle("is-cooling", isCooling);
      button.classList.toggle("is-aiming", Boolean(isAiming));
      button.setAttribute("aria-disabled", String(isCooling));
      button.setAttribute(
        "aria-label",
        `技能${slot} ${def.name}，快捷键 ${slot === 1 ? "U" : "I"}`
      );
      button.title = `${slot === 1 ? "U" : "I"} · ${def.name}${isCooling ? ` · 冷却 ${formatCooldown(cooldown)}` : " · READY"}`;
      button.querySelector(".skill-btn__name").textContent = def.name;
      button.querySelector(".skill-btn__icon").innerHTML = SKILL_ICONS[skill.id] || "";
      cdLabel.textContent = isCooling ? formatCooldown(cooldown) : "READY";
      shade.style.setProperty(
        "--cd-pct",
        `${isCooling ? (cooldown / def.cooldown) * 100 : 0}%`
      );
    }

    els.skillDpad.hidden = !hero.aim;
    if (hero.aim) {
      const skill = hero.skills?.[hero.aim.skill];
      els.skillDpadCenter.textContent = hero.aim.skill === 1 ? "U" : "I";
      if (skill?.id === "shock") {
        const label = hero.aim.direction?.label || "上";
        els.skillHint.textContent = `点击棋盘发动 · 自动朝${label} · WASD 定向`;
      } else {
        els.skillHint.textContent = "按 W / A / S / D 折跃两格";
      }
    } else if (hero.cast) {
      els.skillHint.textContent = hero.cast.phase === "windup"
        ? `震域前摇 · ${Math.max(0, SKILL_LIBRARY.shock.windup - hero.cast.ticks)} 帧`
        : `震域后摇 · ${Math.max(0, SKILL_LIBRARY.shock.backswing - hero.cast.ticks)} 帧`;
    } else {
      const parts = [];
      for (const slot of [1, 2]) {
        const skill = hero.skills?.[slot];
        if (skill) parts.push(`${slot === 1 ? "U" : "I"} ${SKILL_LIBRARY[skill.id].name}`);
      }
      parts.push("Q 未实装");
      if (hero.empowerCharges > 0) parts.push(`强化 ${hero.empowerCharges} 次`);
      els.skillHint.textContent = parts.join(" · ");
    }
  }

  function syncSkillLayer(force = false) {
    const entries = new Map();
    const addEntry = (row, col, data) => {
      if (!inBounds(row, col)) return;
      const key = `${row},${col}`;
      if (!entries.has(key)) {
        entries.set(key, { row, col, ...data });
      }
    };

    for (const piece of allUnits()) {
      if (piece.hp <= 0 || !piece.cast || piece.cast.phase !== "windup") continue;
      const cast = piece.cast;
      const cells = cast.area || areaForDirection(cast.origin.row, cast.origin.col, cast.direction);
      for (const cell of cells) {
        addEntry(cell.row, cell.col, {
          type: "cast",
          center: cell.center
        });
      }
    }

    const hero = selectedHero();
    if (hero && hero.aim) {
      if (hero.aim.skill === 2) {
        const direction = hero.aim.direction || nearestEnemyDirection(hero);
        const cells = areaForDirection(hero.row, hero.col, direction);
        for (const cell of cells) {
          addEntry(cell.row, cell.col, {
            type: "aim",
            center: cell.center
          });
        }
      } else {
        for (const key of Object.keys(DIRECTIONS_BY_KEY)) {
          const direction = DIRECTIONS_BY_KEY[key];
          const row = hero.row + direction.dr * 2;
          const col = hero.col + direction.dc * 2;
          if (!inBounds(row, col)) continue;
          addEntry(row, col, {
            type: "blink",
            label: key,
            invalid: Boolean(isOccupied(row, col, hero.id, hero))
          });
        }
      }
    }

    const key = [...entries.values()]
      .map((entry) => `${entry.row},${entry.col},${entry.type},${entry.center ? 1 : 0},${entry.label || ""},${entry.invalid ? 1 : 0}`)
      .join("|");

    if (!force && key === skillKey) return;
    skillKey = key;

    if (!entries.size) {
      els.skillLayer.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of entries.values()) {
      const node = document.createElement("span");
      node.className = [
        "skill-cell",
        entry.type === "blink" ? "is-blink" : "",
        entry.center ? "is-center" : "",
        entry.invalid ? "is-invalid" : ""
      ]
        .filter(Boolean)
        .join(" ");
      node.style.left = `${pos(entry.col)}%`;
      node.style.top = `${pos(entry.row)}%`;
      if (entry.label) node.textContent = entry.label;
      fragment.appendChild(node);
    }

    els.skillLayer.replaceChildren(fragment);
  }

  function pieceStatusText(piece) {
    if (piece.hp <= 0) {
      return piece.respawnTicks > 0
        ? `复活倒计时 · ${(piece.respawnTicks / 10).toFixed(1)} 秒`
        : "已阵亡";
    }

    if (piece.cast) {
      return piece.cast.phase === "windup"
        ? `震域前摇 · ${Math.max(0, SKILL_LIBRARY.shock.windup - piece.cast.ticks)} 帧`
        : `震域后摇 · ${Math.max(0, SKILL_LIBRARY.shock.backswing - piece.cast.ticks)} 帧`;
    }

    if (piece.aim) {
      const skill = piece.skills?.[piece.aim.skill];
      const def = skill ? SKILL_LIBRARY[skill.id] : null;
      if (skill?.id === "shock") {
        return `${def.name}瞄准 · 朝${piece.aim.direction?.label || "上"}`;
      }
      return `${def?.name || "技能"}瞄准 · 按 WASD 选向`;
    }

    if (piece.state === "attacking") {
      const target = findEntityById(piece.attackTarget);
      const countdown = Math.max(1, CONFIG.ATTACK_INTERVAL_TICKS - piece.attackCharge);
      return target ? `攻击 ${target.name} · ${countdown} 帧后命中` : "攻击中";
    }

    if (piece.state === "recovering") {
      return `后摇中 · 还需 ${piece.recoveryTicks} 帧`;
    }

    if (piece.state === "moving") {
      if (piece.reroute) {
        return `移动中 · 下一格变道`;
      }
      return `移动中 · 剩余 ${piece.path.length} 格`;
    }

    return "待命 · 警戒 8 格";
  }

  function syncInstruction() {
    let text = "";
    let hint = "";

    if (editor.active) {
      text = `创造模式 · ${EDITOR_TOOL_LABELS[editor.tool] || "地图编辑"}`;
      hint = editorToolInstruction();
    } else if (game.status === "over") {
      if (game.winner === "draw") {
        text = "同归于尽 · 对局结束";
      } else {
        text = `${TEAM_DEFS[game.winner].name}获胜 · 对局结束`;
      }
      hint = "点击「重新开局」再来一局";
    } else if (rallyArmed) {
      text = `${TEAM_DEFS[viewTeam].name}全队集合`;
      hint = "点击地图任意位置 · 0 取消";
    } else if (focusState.active && focusedHero()) {
      const hero = focusedHero();
      text = `${hero.name} · 专注模式`;
      hint = "WASD 移动 · J 普攻 · U/I 技能 · 1–5 切人 · P 退出";
    } else if (!game.selected) {
      text = `${TEAM_DEFS[viewTeam].name}视角 · 点击任意一枚己方棋子开始`;
      hint = "~ 切换阵营 · 0 全队集合 · P 专注模式";
    } else {
      const piece = selectedPiece();

      if (piece.aim) {
        if (piece.aim.skill === 2) {
          text = `${piece.name} · 震域瞄准`;
          hint = `点击棋盘发动 · 自动朝${piece.aim.direction?.label || "上"} · WASD 定向`;
        } else {
          text = `${piece.name} · 折跃瞄准`;
          hint = "按 W / A / S / D 选择方向";
        }
      } else if (piece.cast) {
        text = `${piece.name} · ${pieceStatusText(piece)}`;
        hint = "技能施放中 · 无法移动";
      } else if (piece.state === "recovering") {
        text = `${piece.name}后摇中 · 还需 ${piece.recoveryTicks} 帧`;
        hint = game.hoverPlan
          ? `变道预览 ${game.hoverPlan.cellCount} 格 · ${formatEta(game.hoverPlan.ticks)}${game.hoverPlan.engagement ? " · 将自动迎敌" : ""}`
          : "点击空位可以变道";
      } else if (piece.state === "attacking") {
        text = `${piece.name} · ${pieceStatusText(piece)}`;
        hint = "自动战斗中";
      } else if (piece.state === "moving") {
        text = piece.reroute
          ? `${piece.name}移动中 · 下一格变道`
          : `${piece.name}移动中 · 剩余 ${piece.path.length} 格`;
        hint = game.hoverPlan
          ? `变道预览 ${game.hoverPlan.cellCount} 格 · ${formatEta(game.hoverPlan.ticks)}${game.hoverPlan.engagement ? " · 将自动迎敌" : ""}`
          : "点击空位即可变道";
      } else {
        text = `已选${piece.name} · 点击空位落子`;
        if (game.hoverPlan) {
          hint = `预览 ${game.hoverPlan.cellCount} 格 · ${formatEta(game.hoverPlan.ticks)}${game.hoverPlan.engagement ? " · 将自动迎敌" : ""}`;
        } else {
          hint = "斜线路径优先 · 移动中可变道";
        }
      }
    }

    els.instructionText.textContent = text;
    els.instructionHint.textContent = hint;
  }

  function syncSteps() {
    const selected = Boolean(game.selected) && game.status === "playing";
    els.stepOne.classList.toggle("is-done", selected);
    els.stepOne.classList.toggle("is-active", !selected);
    els.stepTwo.classList.toggle("is-active", selected);
  }

  function syncStats() {
    const piece = selectedPiece();

    if (!piece || game.status !== "playing") {
      els.statSelected.textContent = "—";
      els.statSteps.textContent = "—";
      els.statEta.textContent = "—";
      return;
    }

    els.statSelected.textContent = `${piece.name} · ${cellLabel(piece.row, piece.col)}`;

    let stepsText = "—";
    let etaText = "—";

    if (game.hoverPlan) {
      stepsText = `${game.hoverPlan.cellCount} 格`;
      etaText = formatEta(game.hoverPlan.ticks);
    } else if (piece.state === "moving" && piece.path.length) {
      if (piece.reroute) {
        stepsText = `${1 + piece.reroute.path.length} 格`;
        const ticks =
          CONFIG.MOVE_STEP_TICKS -
          piece.moveProgress +
          (piece.reroute.path.length
            ? CONFIG.MOVE_RECOVERY_TICKS + routeTicks(piece.reroute.path.length)
            : 0);
        etaText = formatEta(ticks);
      } else {
        stepsText = `${piece.path.length} 格`;
        const ticks =
          CONFIG.MOVE_STEP_TICKS -
          piece.moveProgress +
          Math.max(0, piece.path.length - 1) *
            (CONFIG.MOVE_STEP_TICKS + CONFIG.MOVE_RECOVERY_TICKS);
        etaText = formatEta(ticks);
      }
    } else if (piece.state === "recovering" && piece.path.length) {
      stepsText = `${piece.path.length} 格`;
      etaText = formatEta(piece.recoveryTicks + routeTicks(piece.path.length));
    } else if (piece.state === "attacking") {
      stepsText = "交战中";
      etaText = "—";
    }

    els.statSteps.textContent = stepsText;
    els.statEta.textContent = etaText;
  }

  function syncSelectedLine() {
    const piece = selectedPiece();
    const dot = els.selectedDot;
    dot.classList.remove("is-red", "is-blue", "is-idle");

    if (!piece) {
      dot.classList.add("is-idle");
      els.selectedState.textContent = "未选择棋子";
      els.selectedHp.textContent = "HP —";
      return;
    }

    dot.classList.add(piece.team === "red" ? "is-red" : "is-blue");
    els.selectedState.textContent = `${piece.name} · ${pieceStatusText(piece)}`;
    els.selectedHp.textContent = `HP ${piece.hp}/${piece.maxHp}`;
  }

  function syncClock() {
    els.gameClock.textContent = formatTime(game.gameMs);
  }

  function syncRange(force = false) {
    const piece = selectedPiece();

    if (!piece || piece.hp <= 0 || game.status !== "playing") {
      if (rangeKey !== "") {
        els.rangeLayer.replaceChildren();
        rangeKey = "";
      }
      return;
    }

    const key = `${piece.id}:${piece.row}:${piece.col}`;
    if (!force && key === rangeKey) return;
    rangeKey = key;

    const team = TEAM_DEFS[piece.team];
    const fragment = document.createDocumentFragment();
    let index = 0;

    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const row = piece.row + dr;
        const col = piece.col + dc;
        if (!inBounds(row, col)) continue;

        const tile = document.createElement("span");
        tile.className = "range-tile";
        tile.style.left = `${pos(col)}%`;
        tile.style.top = `${pos(row)}%`;
        tile.style.setProperty("--range-fill", team.rangeFill);
        tile.style.setProperty("--range-line", team.rangeLine);
        tile.style.setProperty("--range-dot", team.rangeDot);
        tile.style.setProperty("--range-delay", `${index * 14}ms`);
        fragment.appendChild(tile);
        index += 1;
      }
    }

    els.rangeLayer.replaceChildren(fragment);
  }

  function activeRoutePoints(piece) {
    if (!piece || piece.hp <= 0 || game.status !== "playing") return null;

    if (piece.state === "moving" && piece.path.length) {
      const current = { row: piece.row, col: piece.col };
      if (piece.reroute) {
        return [current, piece.path[0], ...piece.reroute.path];
      }
      return [current, ...piece.path];
    }

    if (piece.state === "recovering" && piece.path.length) {
      return [{ row: piece.row, col: piece.col }, ...piece.path];
    }

    return null;
  }

  function syncRoute(force = false) {
    const piece = selectedPiece();
    let points = null;
    let color = "#d9b274";

    if (piece && piece.hp > 0 && game.status === "playing") {
      color = piece.color;
      if (game.hoverPlan) {
        points = game.hoverPlan.points;
      } else {
        points = activeRoutePoints(piece);
      }
    }

    if (!points || points.length < 2) {
      if (routeKey !== "") {
        clearRoute();
        routeKey = "";
      }
      return;
    }

    const key = `${color}:${points.map((point) => `${point.row},${point.col}`).join(":")}`;
    if (!force && key === routeKey) return;
    routeKey = key;
    drawRoute(points, color);
  }

  function drawRoute(points, color) {
    els.board.style.setProperty("--path-color", color);

    const d = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${pos(point.col)} ${pos(point.row)}`)
      .join(" ");

    els.pathLine.setAttribute("d", d);
    els.pathLine.classList.add("is-visible");

    const dots = document.createDocumentFragment();
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(pos(point.col)));
      dot.setAttribute("cy", String(pos(point.row)));
      dot.setAttribute("r", index === 0 ? "0.3" : "0.22");
      dot.setAttribute("class", "path-dot is-visible");
      dots.appendChild(dot);
    }
    els.pathDots.replaceChildren(dots);

    const destination = points[points.length - 1];
    els.destinationMarker.setAttribute(
      "transform",
      `translate(${pos(destination.col)} ${pos(destination.row)})`
    );
    els.destinationMarker.setAttribute("opacity", "1");
  }

  function clearRoute() {
    els.pathLine.setAttribute("d", "");
    els.pathLine.classList.remove("is-visible");
    els.pathDots.replaceChildren();
    els.destinationMarker.setAttribute("opacity", "0");
  }

  /* ---------------------------------------------------------
     Input
     --------------------------------------------------------- */

  /* ---------------------------------------------------------
     Create mode
     --------------------------------------------------------- */

  const EDITOR_TOOL_LABELS = {
    board: "棋盘",
    grass: "草丛",
    wall: "墙壁",
    tower: "防御塔",
    spawn: "英雄出生点",
    "minion-spawn": "蓝方小兵点",
    lane: "兵线路径"
  };

  function teamLabel(team) {
    return team === "red" ? "赤方" : "蓝方";
  }

  function editorToolInstruction(tool = editor.tool) {
    if (tool === "lane" && editor.laneDraft) {
      return `第 ${editor.laneDraft.laneIndex + 1} 条兵线 · 起点为蓝方小兵点 · 移动鼠标延伸，点击确认终点`;
    }
    const hints = {
      board: "点击空位拓展棋盘，点击已有格删除",
      grass: "点击草地格放置或移除草丛，相邻草丛连成一片",
      wall: "点击格子边线放置或拆除墙壁",
      tower: "点击格子放置防御塔，再点同一格拆除",
      spawn: `点击设置${teamLabel(editor.towerTeam)} ${editor.heroSlot + 1} 号英雄出生点`,
      "minion-spawn": "点击设置蓝方小兵刷新点；三条兵线默认从此处出发",
      lane: `选择第 ${editor.laneIndex + 1} 条兵线；起点自动使用蓝方小兵点`,
      clear: "清空地形、英雄出生点、兵线与塔"
    };
    return hints[tool] || "";
  }

  function setEditorTool(tool) {
    if (!EDITOR_TOOL_LABELS[tool] && tool !== "clear") return;
    editor.tool = tool;
    editor.laneDraft = null;
    editor.hoverEdge = null;
    document.querySelectorAll("[data-editor-tool]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.editorTool === tool);
    });
    if (tool === "lane") beginLaneDraft(editor.laneIndex);
    updateEditorHint();
    renderMapLayers();
  }

  function updateEditorHint() {
    if (els.editorHint) els.editorHint.textContent = editorToolInstruction();
    if (editor.active) syncInstruction();
  }

  function syncEditorOptionButtons() {
    document.querySelectorAll("[data-editor-slot]").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.editorSlot) === editor.heroSlot);
    });
    document.querySelectorAll("[data-editor-lane]").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.editorLane) === editor.laneIndex);
    });
  }

  function beginLaneDraft(laneIndex) {
    if (!draftMap) return;
    const start = draftMap.blueMinionSpawn;
    if (!start || !isTile(start.row, start.col, draftMap)) {
      editor.laneDraft = null;
      editor.laneIndex = laneIndex;
      syncEditorOptionButtons();
      updateEditorHint();
      renderLaneLayer();
      showToast("请先设置蓝方小兵刷新点，再绘制兵线。");
      return;
    }
    editor.laneIndex = laneIndex;
    editor.laneDraft = {
      laneIndex,
      cells: [{ row: start.row, col: start.col }]
    };
    syncEditorOptionButtons();
    updateEditorHint();
    renderLaneLayer();
  }

  function refreshEditor() {
    if (!draftMap) return;
    pruneWalls(draftMap);
    rebuildGrassPatches(draftMap);
    updateBoardCells(draftMap);
    renderMapLayers();
    updateEditorHint();
    syncInstruction();
  }

  function validateDraftMap() {
    if (!draftMap.cells.size) return "棋盘上至少要保留一个格子。";

    const used = new Set();
    for (const team of ["red", "blue"]) {
      const spawns = draftMap.heroSpawns?.[team] || [];
      for (let index = 0; index < 5; index += 1) {
        const cell = spawns[index];
        if (!cell) return `请设置${teamLabel(team)} ${index + 1} 号英雄出生点。`;
        if (!isTile(cell.row, cell.col, draftMap)) return `${teamLabel(team)} ${index + 1} 号出生点不在棋盘上。`;
        if (draftMap.towers.some((tower) => tower.row === cell.row && tower.col === cell.col)) {
          return `${teamLabel(team)} ${index + 1} 号出生点与防御塔重叠。`;
        }
        const key = cellKey(cell.row, cell.col);
        if (used.has(key)) return "英雄出生点不能重叠。";
        used.add(key);
      }
    }

    if (!draftMap.blueMinionSpawn || !isTile(draftMap.blueMinionSpawn.row, draftMap.blueMinionSpawn.col, draftMap)) {
      return "请设置蓝方小兵刷新点。";
    }

    for (let index = 0; index < LANE_CONFIG.COUNT; index += 1) {
      const lane = draftMap.lanes?.[index];
      if (!lane || lane.cells.length < 2) return `请绘制第 ${index + 1} 条兵线。`;
      if (!lane.cells.every((cell) => isTile(cell.row, cell.col, draftMap))) {
        return `第 ${index + 1} 条兵线经过无效棋盘格。`;
      }
      const start = lane.cells[0];
      if (start.row !== draftMap.blueMinionSpawn.row || start.col !== draftMap.blueMinionSpawn.col) {
        return `第 ${index + 1} 条兵线必须从蓝方小兵刷新点出发。`;
      }
    }

    for (const team of ["red", "blue"]) {
      if (!draftMap.towers.some((tower) => tower.team === team)) {
        return `${teamLabel(team)}至少需要一座防御塔作为水晶。`;
      }
    }

    return null;
  }

  function enterEditor() {
    if (editor.active) return;
    if (els.helpDialog.open) closeHelp();
    exitFocusMode(true);
    rallyArmed = false;
    document.body.classList.remove("is-rallying");

    draftMap = cloneMap(activeMap);
    editor.active = true;
    editor.savedPaused = paused;
    editor.laneDraft = null;
    editor.hoverEdge = null;
    editor.tool = "board";
    editor.heroSlot = 0;
    editor.laneIndex = 0;
    paused = true;
    accumulator = 0;

    game.selected = null;
    game.hoverPlan = null;
    hoverCell = null;
    clearHoverVisuals();
    clearRoute();

    els.editorBar.hidden = false;
    els.editorBtn.classList.add("is-active");
    els.editorBtn.setAttribute("aria-pressed", "true");
    document.body.classList.add("is-editing");
    document.querySelectorAll("[data-editor-tool]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.editorTool === "board");
    });
    document.querySelectorAll("[data-editor-team]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.editorTeam === editor.towerTeam);
    });
    syncEditorOptionButtons();

    refreshEditor();
    syncAll(true);
    updateEditorHint();
    els.board.focus({ preventScroll: true });
    showToast("创造模式：点击工具后在棋盘上操作。");
  }

  function exitEditor(apply) {
    if (!editor.active) return;

    if (apply) {
      const error = validateDraftMap();
      if (error) {
        showToast(error);
        return;
      }
      activeMap = cloneMap(draftMap);
      draftMap = cloneMap(activeMap);
    } else {
      draftMap = cloneMap(activeMap);
    }

    editor.active = false;
    editor.laneDraft = null;
    editor.hoverEdge = null;
    paused = document.hidden;
    hoverCell = null;
    game.hoverPlan = null;
    clearHoverVisuals();
    lastFrame = performance.now();
    accumulator = 0;

    els.editorBar.hidden = true;
    els.editorBtn.classList.remove("is-active");
    els.editorBtn.setAttribute("aria-pressed", "false");
    document.body.classList.remove("is-editing");
    updateBoardCells(activeMap);
    renderMapLayers();
    syncInstruction();

    if (apply) {
      restartGame();
      showToast("地图已应用，对局重新开始。");
    } else {
      syncAll(true);
      renderPieces();
      showToast("已退出创造模式。");
    }
  }

  function saveBoardDesign() {
    if (!draftMap) return false;
    try {
      const previous = localStorage.getItem(SAVE_KEY);
      if (previous) localStorage.setItem(SAVE_BACKUP_KEY, previous);
      localStorage.setItem(SAVE_KEY, serializeMap(draftMap));
      showToast("棋盘设计已保存，旧版本已备份到本地。");
      return true;
    } catch (error) {
      showToast("保存失败：浏览器无法写入本地存储。");
      return false;
    }
  }

  function exportBoardDesign() {
    if (!draftMap) return;
    try {
      const blob = new Blob([JSON.stringify(JSON.parse(serializeMap(draftMap)), null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      anchor.href = url;
      anchor.download = `yi-board-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast("棋盘已导出为 JSON。");
    } catch (error) {
      showToast("导出失败。");
    }
  }

  function importBoardDesign(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const saved = JSON.parse(String(reader.result || ""));
        const map = mapFromSavedObject(saved);
        if (!map) {
          showToast("导入失败：文件中没有有效棋盘格。");
          return;
        }
        draftMap = map;
        editor.laneDraft = null;
        editor.heroSlot = 0;
        editor.laneIndex = 0;
        syncEditorOptionButtons();
        refreshEditor();
        const missingLanes = map.lanes.every((lane) => !lane) || !map.blueMinionSpawn;
        showToast(missingLanes
          ? "棋盘已导入；该存档缺少兵线或蓝方小兵点，开始对局前需要补齐。"
          : "棋盘已导入。");
      } catch (error) {
        showToast("导入失败：JSON 格式不正确。");
      }
    };
    reader.readAsText(file);
  }

  function resetEditor() {
    draftMap = createDefaultMap();
    editor.laneDraft = null;
    editor.hoverEdge = null;
    editor.heroSlot = 0;
    editor.laneIndex = 0;
    syncEditorOptionButtons();
    refreshEditor();
    showToast("已恢复到默认 25×25 核心地图。");
  }

  function clearMapObjects() {
    draftMap.grass.clear();
    draftMap.walls.clear();
    draftMap.towers = [];
    draftMap.heroSpawns = {
      red: Array.from({ length: 5 }, () => null),
      blue: Array.from({ length: 5 }, () => null)
    };
    draftMap.blueMinionSpawn = null;
    draftMap.lanes = Array.from({ length: LANE_CONFIG.COUNT }, () => null);
    editor.laneDraft = null;
    refreshEditor();
    showToast("已清空地形、英雄出生点与兵线。");
  }

  function toggleBoardCell(row, col) {
    if (!draftMap) return;
    const key = cellKey(row, col);
    if (draftMap.cells.has(key)) {
      draftMap.cells.delete(key);
      draftMap.grass.delete(key);
      draftMap.towers = draftMap.towers.filter((tower) => tower.row !== row || tower.col !== col);
      for (const team of ["red", "blue"]) {
        draftMap.heroSpawns[team] = draftMap.heroSpawns[team].map((cell) =>
          cell && cell.row === row && cell.col === col ? null : cell
        );
      }
      if (draftMap.blueMinionSpawn && draftMap.blueMinionSpawn.row === row && draftMap.blueMinionSpawn.col === col) {
        draftMap.blueMinionSpawn = null;
      }
      draftMap.lanes = draftMap.lanes.map((lane) => {
        if (!lane) return null;
        return lane.cells.some((cell) => cell.row === row && cell.col === col) ? null : lane;
      });
      if (editor.laneDraft?.cells.some((cell) => cell.row === row && cell.col === col)) {
        editor.laneDraft = null;
      }
      pruneWalls(draftMap);
    } else {
      draftMap.cells.add(key);
    }
    refreshEditor();
  }

  function toggleGrass(row, col) {
    if (!draftMap || !isTile(row, col, draftMap)) return;
    const key = cellKey(row, col);
    if (draftMap.grass.has(key)) draftMap.grass.delete(key);
    else draftMap.grass.add(key);
    refreshEditor();
  }

  function toggleTower(row, col) {
    if (!draftMap || !isTile(row, col, draftMap)) return;
    const existing = draftMap.towers.find((tower) => tower.row === row && tower.col === col);
    if (existing) {
      draftMap.towers = draftMap.towers.filter((tower) => tower !== existing);
    } else {
      const occupied = [...draftMap.heroSpawns.red, ...draftMap.heroSpawns.blue].some(
        (cell) => cell && cell.row === row && cell.col === col
      );
      if (occupied) {
        showToast("英雄出生点上不能放置防御塔。");
        return;
      }
      draftMap.towers.push({ row, col, team: editor.towerTeam });
    }
    refreshEditor();
  }

  function setEditorSpawn(kind, row, col) {
    if (!draftMap || !isTile(row, col, draftMap)) return;

    if (kind === "minion") {
      draftMap.blueMinionSpawn = { row, col };
      if (draftMap.lanes.some(Boolean)) {
        draftMap.lanes = Array.from({ length: LANE_CONFIG.COUNT }, () => null);
        editor.laneDraft = null;
        showToast("蓝方小兵点已移动，请重新绘制三条兵线。");
      }
      refreshEditor();
      return;
    }

    const team = editor.towerTeam;
    const slot = editor.heroSlot;
    let duplicate = false;
    for (const spawnTeam of ["red", "blue"]) {
      for (let index = 0; index < 5; index += 1) {
        if (spawnTeam === team && index === slot) continue;
        const cell = draftMap.heroSpawns[spawnTeam][index];
        if (cell && cell.row === row && cell.col === col) duplicate = true;
      }
    }
    if (duplicate) {
      showToast("英雄出生点不能与另一个出生点重叠。");
      return;
    }
    if (draftMap.towers.some((tower) => tower.row === row && tower.col === col)) {
      showToast("英雄出生点上不能与防御塔重叠。");
      return;
    }

    draftMap.heroSpawns[team][slot] = { row, col };
    refreshEditor();
  }

  function appendLaneTo(row, col) {
    if (!editor.laneDraft) return;
    const cells = editor.laneDraft.cells;
    let last = cells[cells.length - 1];
    let guard = 0;

    while ((last.row !== row || last.col !== col) && guard < 300) {
      guard += 1;
      const dr = Math.sign(row - last.row);
      const dc = Math.sign(col - last.col);
      if (dr === 0 && dc === 0) break;

      const next = Math.abs(row - last.row) >= Math.abs(col - last.col)
        ? { row: last.row + dr, col: last.col }
        : { row: last.row, col: last.col + dc };

      if (!isTile(next.row, next.col, draftMap)) break;
      if (next.row === last.row && next.col === last.col) break;

      const previous = cells.length > 1 ? cells[cells.length - 2] : null;
      if (previous && previous.row === next.row && previous.col === next.col) {
        cells.pop();
      } else {
        cells.push(next);
      }
      last = cells[cells.length - 1];
    }

    renderLaneLayer();
    updateEditorHint();
  }

  function handleEditorClick(event) {
    if (!editor.active) return;

    if (editor.tool === "clear") {
      clearMapObjects();
      setEditorTool("board");
      return;
    }

    if (editor.tool === "wall") {
      const edge = edgeFromClient(event.clientX, event.clientY);
      if (!edge) {
        showToast("请点击格子的边线来放置墙壁。");
        return;
      }
      const key = wallKey(edge.axis, edge.row, edge.col);
      if (draftMap.walls.has(key)) draftMap.walls.delete(key);
      else draftMap.walls.add(key);
      editor.hoverEdge = null;
      refreshEditor();
      return;
    }

    const cell = gridCellFromClient(event.clientX, event.clientY);
    if (!cell) return;

    if (editor.tool === "board") {
      toggleBoardCell(cell.row, cell.col);
      return;
    }

    if (!isTile(cell.row, cell.col, draftMap)) {
      showToast("这个空位还没有棋盘格。");
      return;
    }

    if (editor.tool === "grass") {
      toggleGrass(cell.row, cell.col);
      return;
    }

    if (editor.tool === "tower") {
      toggleTower(cell.row, cell.col);
      return;
    }

    if (editor.tool === "spawn" || editor.tool === "minion-spawn") {
      setEditorSpawn(editor.tool === "spawn" ? "spawn" : "minion", cell.row, cell.col);
      return;
    }

    if (editor.tool === "lane") {
      if (!editor.laneDraft) {
        beginLaneDraft(editor.laneIndex);
        return;
      }

      appendLaneTo(cell.row, cell.col);
      const cells = editor.laneDraft.cells;
      if (cells.length < 2) {
        showToast("兵线至少需要两个格子。");
        return;
      }
      const laneIndex = editor.laneDraft.laneIndex;
      draftMap.lanes[laneIndex] = {
        id: laneIndex,
        cells: cells.map((entry) => ({ ...entry }))
      };
      editor.laneDraft = null;
      const nextMissing = draftMap.lanes.findIndex((lane) => !lane);
      editor.laneIndex = nextMissing >= 0 ? nextMissing : laneIndex;
      syncEditorOptionButtons();
      refreshEditor();
      showToast(`第 ${laneIndex + 1} 条兵线已记录 · ${cells.length} 格。`);
    }
  }

  function handleEditorPointerMove(event) {
    if (!editor.active) return;

    const cell = gridCellFromClient(event.clientX, event.clientY);
    if (!cell) {
      hideCursor();
      return;
    }

    hoverCell = { row: cell.row, col: cell.col };
    positionCursor(cell, true);

    if (editor.tool === "lane" && editor.laneDraft) {
      appendLaneTo(cell.row, cell.col);
    }

    if (editor.tool === "wall") {
      const edge = edgeFromClient(event.clientX, event.clientY);
      const key = edge ? wallKey(edge.axis, edge.row, edge.col) : "";
      const previousKey = editor.hoverEdge
        ? wallKey(editor.hoverEdge.axis, editor.hoverEdge.row, editor.hoverEdge.col)
        : "";
      if (key !== previousKey) {
        editor.hoverEdge = edge;
        renderMapLayers();
      }
    }
  }

  function handleEditorPointerLeave() {
    hideCursor();
    hoverCell = null;
    if (editor.hoverEdge) {
      editor.hoverEdge = null;
      renderMapLayers();
    }
  }

  function edgeFromClient(clientX, clientY) {
    const rect = els.board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    const fx = (x - BOARD_MARGIN) / CELL_SIZE;
    const fy = (y - BOARD_MARGIN) / CELL_SIZE;
    if (fx < -0.35 || fx > CONFIG.SIZE - 0.65 || fy < -0.35 || fy > CONFIG.SIZE - 0.65) return null;

    const hBoundary = Math.round(fy);
    const vBoundary = Math.round(fx);
    const colAtH = Math.max(0, Math.min(CONFIG.SIZE - 1, Math.floor(fx)));
    const rowAtV = Math.max(0, Math.min(CONFIG.SIZE - 1, Math.floor(fy)));
    const candidates = [];

    if (
      hBoundary >= 0 && hBoundary <= CONFIG.SIZE &&
      Math.abs(fy - hBoundary) <= 0.34 &&
      (isTile(hBoundary - 1, colAtH, draftMap) || isTile(hBoundary, colAtH, draftMap))
    ) {
      candidates.push({
        axis: "h",
        row: hBoundary,
        col: colAtH,
        distance: Math.abs(fy - hBoundary)
      });
    }

    if (
      vBoundary >= 0 && vBoundary <= CONFIG.SIZE &&
      Math.abs(fx - vBoundary) <= 0.34 &&
      (isTile(rowAtV, vBoundary - 1, draftMap) || isTile(rowAtV, vBoundary, draftMap))
    ) {
      candidates.push({
        axis: "v",
        row: rowAtV,
        col: vBoundary,
        distance: Math.abs(fx - vBoundary)
      });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0] || null;
  }

  function bindEvents() {
    els.board.addEventListener("pointermove", handlePointerMove);
    els.board.addEventListener("pointerleave", handlePointerLeave);
    els.board.addEventListener("click", handleBoardClick);

    els.skillBtn1.addEventListener("click", () => {
      if (focusState.active) focusSkill(1);
      else handleSkillSelect(1);
    });
    els.skillBtn2.addEventListener("click", () => {
      if (focusState.active) focusSkill(2);
      else handleSkillSelect(2);
    });
    els.skillDpad.querySelectorAll(".skill-dir").forEach((button) => {
      button.addEventListener("click", () => castAimedDirection(button.dataset.dir));
    });

    els.restartBtn.addEventListener("click", restartGame);
    els.replayBtn.addEventListener("click", restartGame);

    els.editorBtn.addEventListener("click", () => {
      if (editor.active) exitEditor(false);
      else enterEditor();
    });
    document.querySelectorAll("[data-editor-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.editorTool === "clear") {
          clearMapObjects();
          setEditorTool("board");
          return;
        }
        setEditorTool(button.dataset.editorTool);
      });
    });
    document.querySelectorAll("[data-editor-team]").forEach((button) => {
      button.addEventListener("click", () => {
        editor.towerTeam = button.dataset.editorTeam;
        document.querySelectorAll("[data-editor-team]").forEach((other) => {
          other.classList.toggle("is-active", other === button);
        });
        updateEditorHint();
      });
    });
    document.querySelectorAll("[data-editor-slot]").forEach((button) => {
      button.addEventListener("click", () => {
        editor.heroSlot = Number(button.dataset.editorSlot);
        syncEditorOptionButtons();
        updateEditorHint();
      });
    });
    document.querySelectorAll("[data-editor-lane]").forEach((button) => {
      button.addEventListener("click", () => {
        editor.laneIndex = Number(button.dataset.editorLane);
        syncEditorOptionButtons();
        if (editor.tool === "lane") beginLaneDraft(editor.laneIndex);
        updateEditorHint();
      });
    });
    els.editorApply.addEventListener("click", () => exitEditor(true));
    els.editorSave.addEventListener("click", saveBoardDesign);
    els.editorImport.addEventListener("click", () => els.boardImportFile.click());
    els.editorExport.addEventListener("click", exportBoardDesign);
    els.boardImportFile.addEventListener("change", () => {
      const file = els.boardImportFile.files?.[0];
      importBoardDesign(file);
      els.boardImportFile.value = "";
    });
    els.editorReset.addEventListener("click", resetEditor);
    els.editorCancel.addEventListener("click", () => exitEditor(false));

    els.helpBtn.addEventListener("click", openHelp);
    els.closeHelp.addEventListener("click", closeHelp);
    els.understoodBtn.addEventListener("click", closeHelp);
    els.helpDialog.addEventListener("close", handleHelpClosed);
    els.helpDialog.addEventListener("click", (event) => {
      if (event.target === els.helpDialog) closeHelp();
    });

    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("keyup", handleGlobalKeyup);
    window.addEventListener("blur", () => {
      focusState.keys.clear();
      focusState.lastKey = null;
      focusState.lastDir = null;
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        paused = true;
      } else {
        paused = Boolean(els.helpDialog.open) || editor.active;
        lastFrame = performance.now();
        accumulator = 0;
      }
    });
  }

  function handleGlobalKeydown(event) {
    if (event.repeat) return;
    if (editor.active) {
      if (event.key === "Escape" && !els.helpDialog.open) {
        event.preventDefault();
        exitEditor(false);
      }
      return;
    }
    if (game.status !== "playing" || els.helpDialog.open) return;

    const key = event.key.toLowerCase();

    if (key === "~" || key === "`") {
      event.preventDefault();
      toggleLockTeam();
      return;
    }

    if (key >= "1" && key <= "5") {
      event.preventDefault();
      selectLockedHero(Number(key));
      return;
    }

    if (key === "p") {
      event.preventDefault();
      toggleFocusMode();
      return;
    }

    if (key === "0") {
      event.preventDefault();
      if (focusState.active) {
        showToast("专注模式下不能下达全队集合。");
        return;
      }
      rallyArmed = !rallyArmed;
      document.body.classList.toggle("is-rallying", rallyArmed);
      showToast(rallyArmed ? "点击地图任意位置，全队集合。" : "已取消集合指令。");
      syncInstruction();
      return;
    }

    if (key === "u" || key === "i") {
      event.preventDefault();
      const slot = key === "u" ? 1 : 2;
      if (focusState.active) focusSkill(slot);
      else handleSkillSelect(slot);
      return;
    }

    if (key === "q") {
      event.preventDefault();
      showToast("三技能未实装。");
      return;
    }

    if (key === "j") {
      if (!focusState.active) return;
      event.preventDefault();
      requestFocusAttack();
      return;
    }

    if (key === "w" || key === "a" || key === "s" || key === "d") {
      if (focusState.active) {
        event.preventDefault();
        const direction = FOCUS_DIRECTIONS[key];
        focusState.keys.add(key);
        focusState.lastKey = key;
        focusState.lastDir = direction;
        return;
      }
      const hero = selectedHero();
      if (hero && hero.aim) {
        event.preventDefault();
        castAimedDirection(key.toUpperCase());
      }
      return;
    }

    if (key === "escape") {
      event.preventDefault();
      if (focusState.active) {
        exitFocusMode(false);
        return;
      }
      if (rallyArmed) {
        rallyArmed = false;
        document.body.classList.remove("is-rallying");
        showToast("已取消集合指令。");
        syncInstruction();
        return;
      }
      const hero = selectedHero();
      if (hero && hero.aim) {
        cancelAim(hero, false);
      } else if (game.selected) {
        game.selected = null;
        game.hoverPlan = null;
        syncAll(true);
      }
    }
  }

  function handleGlobalKeyup(event) {
    if (!focusState.active) return;
    const key = event.key.toLowerCase();
    if (!FOCUS_DIRECTIONS[key]) return;
    focusState.keys.delete(key);
    if (focusState.lastKey === key) {
      const remaining = [...focusState.keys];
      focusState.lastKey = remaining.length ? remaining[remaining.length - 1] : null;
      focusState.lastDir = focusState.lastKey ? FOCUS_DIRECTIONS[focusState.lastKey] : null;
    }
  }

  function handlePointerMove(event) {
    if (editor.active) {
      handleEditorPointerMove(event);
      return;
    }
    if (event.pointerType === "touch") return;
    if (game.status !== "playing") {
      hideCursor();
      return;
    }

    const cell = cellFromClient(event.clientX, event.clientY);
    if (!cell) {
      hoverCell = null;
      game.hoverPlan = null;
      hideCursor();
      syncRoute();
      syncStats();
      syncInstruction();
      return;
    }

    if (!hoverCell || hoverCell.row !== cell.row || hoverCell.col !== cell.col) {
      hoverCell = cell;
      updateHoverState();
    }

    positionCursor(cell);
  }

  function handlePointerLeave() {
    if (editor.active) {
      handleEditorPointerLeave();
      return;
    }
    hoverCell = null;
    hideCursor();
    if (game) {
      game.hoverPlan = null;
      syncRoute();
      syncStats();
      syncInstruction();
    }
  }

  function visibleEnemyEntityAt(row, col, team) {
    const pieces = allUnits().filter(
      (piece) =>
        piece.team !== team &&
        piece.hp > 0 &&
        piece.row === row &&
        piece.col === col &&
        isEntityVisibleToViewTeam(piece)
    );
    if (pieces.length) return pieces[0];
    const minions = game.minions.filter(
      (minion) =>
        minion.team !== team &&
        minion.hp > 0 &&
        minion.row === row &&
        minion.col === col &&
        isEntityVisibleToViewTeam(minion)
    );
    if (minions.length) return minions.sort((a, b) => a.hp - b.hp)[0];
    const towers = game.towers.filter(
      (tower) =>
        tower.team !== team &&
        tower.row === row &&
        tower.col === col &&
        isEntityVisibleToViewTeam(tower)
    );
    return towers[0] || null;
  }

  function handleBoardClick(event) {
    if (editor.active) {
      handleEditorClick(event);
      return;
    }
    if (game.status !== "playing") return;

    const cell = cellFromClient(event.clientX, event.clientY);
    const armedHero = selectedHero();
    if (armedHero && armedHero.aim) {
      if (armedHero.aim.skill === 2) {
        startSkill2(armedHero, nearestEnemyDirection(armedHero));
      } else {
        cancelAim(armedHero, true);
        showToast("按 W / A / S / D 或方向按钮选择折跃方向。");
      }
      return;
    }

    if (rallyArmed) {
      if (!cell) {
        showToast("请点击一个有效位置。");
        return;
      }
      rallyAllHeroes(cell.row, cell.col);
      return;
    }

    if (!cell) return;

    const selected = selectedPiece();
    const commandHero = selected && selected.hp > 0 ? selected : null;
    let clickedPiece = pieceAt(cell.row, cell.col);
    if (clickedPiece && !isEntityVisibleToViewTeam(clickedPiece)) clickedPiece = null;

    if (clickedPiece) {
      if (isFocusedHero(commandHero) && clickedPiece.team === commandHero.team) {
        enterFocusMode(clickedPiece, true);
        return;
      }
      if (commandHero && clickedPiece.team !== commandHero.team) {
        if (isFocusedHero(commandHero)) {
          showToast("专注模式：使用 J 普攻，U/I 技能。");
          return;
        }
        commandTrackTarget(commandHero, clickedPiece);
        hoverCell = cell;
        updateHoverState();
        positionCursor(cell);
        return;
      }
      selectUnit(clickedPiece);
      hoverCell = cell;
      updateHoverState();
      positionCursor(cell);
      return;
    }

    if (commandHero && !isFocusedHero(commandHero)) {
      const target = visibleEnemyEntityAt(cell.row, cell.col, commandHero.team);
      if (target) {
        commandTrackTarget(commandHero, target);
        hoverCell = cell;
        updateHoverState();
        positionCursor(cell);
        return;
      }
    }

    if (isFocusedHero(commandHero)) {
      showToast("专注模式：使用 W/A/S/D 移动，J 普攻。");
      return;
    }

    if (!commandHero) {
      showToast("请先点击一枚棋子。");
      return;
    }

    if (commandHero.state === "attacking") {
      showToast("棋子正在自动战斗，暂时无法变道。");
      return;
    }

    if (commandHero.state === "casting") {
      showToast("技能施放中，无法移动。");
      return;
    }

    const plan = makeMovePlan(commandHero, cell.row, cell.col);
    if (!plan) {
      showToast("无法到达该位置。");
      return;
    }

    if (commandHero.state === "idle") {
      issueMove(commandHero, plan);
    } else {
      applyReroute(commandHero, plan);
    }
  }

  function visualPieceAtClient(clientX, clientY) {
    const rect = els.board.getBoundingClientRect();
    if (!rect.width) return null;

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    const hitRadiusSq = 2.25 * 2.25;
    let best = null;
    let bestDistanceSq = Infinity;

    for (const piece of allUnits()) {
      if (piece.hp <= 0) continue;
      const visual = visualPosition(piece);
      const dx = x - visual.x;
      const dy = y - visual.y;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq <= hitRadiusSq && distanceSq < bestDistanceSq) {
        best = piece;
        bestDistanceSq = distanceSq;
      }
    }

    return best;
  }

  function selectUnit(piece) {
    if (game.status !== "playing" || piece.hp <= 0) return;
    if (piece.team !== viewTeam) {
      showToast(`按 ~ 切换到${TEAM_DEFS[piece.team].name}后再控制。`);
      return;
    }

    const previous = selectedPiece();
    if (previous && previous.id !== piece.id) {
      previous.aim = null;
    }

    if (game.selected === piece.id) {
      if (piece.state === "idle") {
        piece.aim = null;
        game.selected = null;
      }
    } else {
      game.selected = piece.id;
    }

    game.hoverPlan = null;
    syncAll(true);
  }

  function gridCellFromClient(clientX, clientY) {
    const rect = els.board.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;

    if (x < BOARD_MARGIN || x >= BOARD_MARGIN + BOARD_SPAN) return null;
    if (y < BOARD_MARGIN || y >= BOARD_MARGIN + BOARD_SPAN) return null;

    const col = Math.floor((x - BOARD_MARGIN) / CELL_SIZE);
    const row = Math.floor((y - BOARD_MARGIN) / CELL_SIZE);

    if (row < 0 || row >= CONFIG.SIZE || col < 0 || col >= CONFIG.SIZE) return null;
    return { row, col };
  }

  function cellFromClient(clientX, clientY) {
    const cell = gridCellFromClient(clientX, clientY);
    if (!cell || !inBounds(cell.row, cell.col)) return null;
    return cell;
  }

  function updateHoverState() {
    if (!hoverCell || !game || game.status !== "playing") {
      game.hoverPlan = null;
      syncRoute();
      syncStats();
      syncInstruction();
      return;
    }

    const piece = selectedPiece();
    const occupied = pieceAt(hoverCell.row, hoverCell.col);

    if (
      !piece ||
      occupied ||
      piece.aim ||
      piece.cast ||
      piece.state === "attacking" ||
      piece.state === "defeated" ||
      piece.state === "casting"
    ) {
      game.hoverPlan = null;
    } else {
      game.hoverPlan = makeMovePlan(piece, hoverCell.row, hoverCell.col);
    }

    syncRoute();
    syncStats();
    syncInstruction();
    styleCursorForHover();
  }

  function positionCursor(cell, allowVoid = false) {
    const { row, col } = cell;
    if (!allowVoid && !inBounds(row, col)) return;
    if (row < 0 || row >= CONFIG.SIZE || col < 0 || col >= CONFIG.SIZE) return;

    els.cursorMark.style.left = `${pos(col)}%`;
    els.cursorMark.style.top = `${pos(row)}%`;
    els.cursorMark.classList.add("is-visible");

    els.coordTip.textContent = cellLabel(row, col);
    els.coordTip.style.left = `${pos(col)}%`;
    els.coordTip.style.top = `${pos(row)}%`;
    els.coordTip.classList.toggle("is-below", row < 3);
    els.coordTip.classList.add("is-visible");

    styleCursorForHover();
  }

  function styleCursorForHover() {
    if (!hoverCell) return;

    const piece = pieceAt(hoverCell.row, hoverCell.col);
    const selected = selectedPiece();
    let color = "rgba(255, 249, 230, 0.55)";

    if (piece) {
      color = piece.color;
    } else if (selected && game.hoverPlan) {
      color = selected.color;
    }

    els.cursorMark.style.borderColor = color;
    els.cursorMark.style.boxShadow = `0 0 10px ${hexToRgba(color, 0.18)}, 0 0 0 1px rgba(0, 0, 0, 0.25)`;
  }

  function hideCursor() {
    els.cursorMark.classList.remove("is-visible");
    els.coordTip.classList.remove("is-visible");
  }

  function clearHoverVisuals() {
    if (!els.cursorMark) return;
    hideCursor();
    els.cursorMark.style.borderColor = "";
    els.cursorMark.style.boxShadow = "";
  }

  /* ---------------------------------------------------------
     Strike / skill effects
     --------------------------------------------------------- */

  function showSkillBlast(cells) {
    for (const cell of cells) {
      const node = document.createElement("span");
      node.className = "skill-burst";
      node.style.left = `${pos(cell.col)}%`;
      node.style.top = `${pos(cell.row)}%`;
      els.board.appendChild(node);
      later(() => node.remove(), 700);
    }
  }

  function showBlinkEffect(fromRow, fromCol, toRow, toCol, color) {
    for (const point of [
      { row: fromRow, col: fromCol },
      { row: toRow, col: toCol }
    ]) {
      const node = document.createElement("span");
      node.className = "blink-ring";
      node.style.left = `${pos(point.col)}%`;
      node.style.top = `${pos(point.row)}%`;
      node.style.setProperty("--blink-color", color);
      els.board.appendChild(node);
      later(() => node.remove(), 560);
    }
  }

  function spawnStrikeEffect(attacker, target) {
    const origin = visualPosition(attacker);
    const impact = visualPosition(target);
    const color = attacker.color;

    const beam = document.createElementNS(SVG_NS, "line");
    beam.setAttribute("x1", String(origin.x));
    beam.setAttribute("y1", String(origin.y));
    beam.setAttribute("x2", String(impact.x));
    beam.setAttribute("y2", String(impact.y));
    beam.setAttribute("class", "strike-beam");
    beam.style.setProperty("--strike-color", color);
    els.fxLayer.appendChild(beam);

    const core = document.createElementNS(SVG_NS, "line");
    core.setAttribute("x1", String(origin.x));
    core.setAttribute("y1", String(origin.y));
    core.setAttribute("x2", String(impact.x));
    core.setAttribute("y2", String(impact.y));
    core.setAttribute("class", "strike-beam strike-beam--core");
    core.style.setProperty("--strike-color", color);
    els.fxLayer.appendChild(core);

    const ring = document.createElement("span");
    ring.className = "impact-ring";
    ring.style.left = `${impact.x}%`;
    ring.style.top = `${impact.y}%`;
    ring.style.setProperty("--strike-color", color);
    els.board.appendChild(ring);

    for (const entity of [attacker, target]) {
      const el = entityRoot(entity);
      if (!el) continue;
      el.classList.remove("is-attacking");
      el.classList.add("is-attacking");
      later(() => el.classList.remove("is-attacking"), 460);
    }

    els.board.classList.remove("is-shaking");
    void els.board.offsetWidth;
    els.board.classList.add("is-shaking");

    later(() => {
      beam.remove();
      core.remove();
      ring.remove();
      els.board.classList.remove("is-shaking");
    }, 700);
  }

  /* ---------------------------------------------------------
     Result / restart / dialog
     --------------------------------------------------------- */

  function showResult() {
    if (game.status !== "over" || game.resultShown) return;
    game.resultShown = true;

    const stone = els.resultStone;
    stone.className = "result__stone";

    if (game.winner === "draw") {
      stone.textContent = "和";
      stone.classList.add("is-draw");
      els.resultTitle.textContent = "水晶同毁";
      els.resultDesc.textContent = "双方水晶同时被摧毁。";
      els.resultRemaining.textContent = "0";
    } else {
      const winner = TEAM_DEFS[game.winner];
      const loser = game.winner === "red" ? TEAM_DEFS.blue : TEAM_DEFS.red;
      const survivors = livingUnits(game.winner).length;

      stone.textContent = winner.short;
      stone.classList.toggle("is-blue", game.winner === "blue");
      els.resultTitle.textContent = `${winner.name}获胜`;
      els.resultDesc.textContent = `${loser.name}水晶被摧毁 · 剩余 ${survivors} 名英雄。`;
      els.resultRemaining.textContent = String(survivors);
    }

    els.resultTime.textContent = formatTime(game.gameMs);
    els.resultOverlay.classList.add("is-open");
    els.resultOverlay.setAttribute("aria-hidden", "false");

    later(() => els.replayBtn.focus({ preventScroll: true }), 300);
  }

  function restartGame() {
    if (editor.active) return;
    clearAllTimers();
    clearFx();
    closeHelp();
    resetControlState();
    game.markedTargetId = null;
    game.rallyPoint = null;

    els.resultOverlay.classList.remove("is-open");
    els.resultOverlay.setAttribute("aria-hidden", "true");
    els.board.classList.remove("is-shaking");

    const starts = heroStartCells();
    for (const def of UNITS) {
      const root = pieceEls[def.id].root;
      root.className = `piece piece--${def.team}${def.number === 1 ? " is-hero" : ""}`;
      root.classList.remove("is-targeted", "is-attacking", "is-hit", "is-defeated", "is-in-grass", "is-exposed");
      root.style.left = `${pos(starts[def.id].col)}%`;
      root.style.top = `${pos(starts[def.id].row)}%`;
      pieceEls[def.id].body.style.transform = "";
      pieceEls[def.id].eye.classList.remove("is-visible");
    }

    for (const id of Object.keys(minionEls)) {
      minionEls[id].root.remove();
      delete minionEls[id];
    }
    for (const id of Object.keys(towerEls)) {
      towerEls[id].root.remove();
      delete towerEls[id];
    }
    els.minionLayer.replaceChildren();
    els.towerLayer.replaceChildren();

    hoverCell = null;
    clearHoverVisuals();
    clearRoute();
    els.rangeLayer.replaceChildren();
    els.skillLayer.replaceChildren();
    els.toast.classList.remove("is-visible");
    routeKey = "";
    rangeKey = "";
    skillKey = "";

    game = createGame();
    seedInitialLogs();
    visualTime = 0;
    syncAll(true);
    renderPieces();
    lastFrame = performance.now();
    accumulator = 0;
  }

  function openHelp() {
    if (!els.helpDialog.open) {
      paused = true;
      els.helpDialog.showModal();
    }
  }

  function closeHelp() {
    if (els.helpDialog.open) {
      els.helpDialog.close();
    }
  }

  function handleHelpClosed() {
    if (document.hidden || editor.active) {
      paused = true;
      return;
    }
    paused = false;
    lastFrame = performance.now();
    accumulator = 0;
  }

  function clearFx() {
    if (els.fxLayer) els.fxLayer.replaceChildren();
    if (els.board) {
      els.board
        .querySelectorAll(".impact-ring, .skill-burst, .blink-ring")
        .forEach((node) => node.remove());
    }
  }

  /* ---------------------------------------------------------
     Log / toast / timers
     --------------------------------------------------------- */

  function addLog(tag, type, message) {
    if (!game) return;

    game.logs.unshift({ tag, type, message });
    if (game.logs.length > 12) game.logs.length = 12;
    renderLogs();
  }

  function renderLogs() {
    const fragment = document.createDocumentFragment();

    for (const entry of game.logs) {
      const item = document.createElement("li");
      item.className = `log-item log-item--${entry.type}`;

      const tag = document.createElement("span");
      tag.className = "log-item__tag";
      tag.textContent = entry.tag;

      const text = document.createElement("span");
      text.className = "log-item__text";
      text.textContent = entry.message;

      item.append(tag, text);
      fragment.appendChild(item);
    }

    els.logList.replaceChildren(fragment);
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");

    if (toastTimer) {
      clearTimeout(toastTimer);
      timers.delete(toastTimer);
    }

    toastTimer = setTimeout(() => {
      timers.delete(toastTimer);
      toastTimer = null;
      els.toast.classList.remove("is-visible");
    }, 1800);

    timers.add(toastTimer);
  }

  function later(callback, delay) {
    let id = null;
    id = setTimeout(() => {
      timers.delete(id);
      callback();
    }, delay);
    timers.add(id);
    return id;
  }

  function clearAllTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    toastTimer = null;
  }

  /* ---------------------------------------------------------
     Debug API
     --------------------------------------------------------- */

  window.__YI__ = {
    config: { ...CONFIG },
    snapshot() {
      return {
        status: game.status,
        winner: game.winner,
        tick: game.tick,
        gameMs: game.gameMs,
        selected: game.selected,
        teams: {
          red: { alive: livingUnits("red").length },
          blue: { alive: livingUnits("blue").length }
        },
        pieces: Object.fromEntries(
          allUnits().map((piece) => [
            piece.id,
            {
              team: piece.team,
              name: piece.name,
              number: piece.number,
              isHero: piece.isHero,
              row: piece.row,
              col: piece.col,
              cell: cellLabel(piece.row, piece.col),
              hp: piece.hp,
              maxHp: piece.maxHp,
              state: piece.state,
              cooldowns: piece.skills
                ? {
                    1: piece.skills[1]?.cooldown ?? null,
                    2: piece.skills[2]?.cooldown ?? null
                  }
                : null,
              skillIds: piece.skills
                ? {
                    1: piece.skills[1]?.id ?? null,
                    2: piece.skills[2]?.id ?? null
                  }
                : null,
              empowerCharges: piece.empowerCharges,
              respawnTicks: piece.respawnTicks,
              lastCommandTick: piece.lastCommandTick,
              manualTargetId: piece.manualTargetId,
              aiLaneMode: piece.aiLaneMode,
              queuedAttack: piece.queuedAttack,
              aim: piece.aim
                ? {
                    skill: piece.aim.skill,
                    direction: piece.aim.direction ? { ...piece.aim.direction } : null
                  }
                : null,
              cast: piece.cast
                ? {
                    skill: piece.cast.skill,
                    phase: piece.cast.phase,
                    ticks: piece.cast.ticks,
                    origin: { ...piece.cast.origin },
                    direction: { ...piece.cast.direction },
                    area: piece.cast.area.map((cell) => ({ ...cell }))
                  }
                : null,
              path: piece.path.map((step) => ({ ...step })),
              destination: piece.destination ? { ...piece.destination } : null,
              reroute: piece.reroute
                ? {
                    target: { ...piece.reroute.target },
                    path: piece.reroute.path.map((step) => ({ ...step }))
                  }
                : null,
              moveProgress: piece.moveProgress,
              recoveryTicks: piece.recoveryTicks,
              attackTarget: piece.attackTarget,
              attackCharge: piece.attackCharge
            }
          ])
        ),
        towers: game.towers.map((tower) => ({
          id: tower.id,
          team: tower.team,
          row: tower.row,
          col: tower.col,
          cell: cellLabel(tower.row, tower.col),
          hp: tower.hp,
          maxHp: tower.maxHp,
          isCrystal: tower.isCrystal,
          target: tower.attackTarget
        })),
        minions: game.minions.map((minion) => ({
          id: minion.id,
          team: minion.team,
          row: minion.row,
          col: minion.col,
          cell: cellLabel(minion.row, minion.col),
          hp: minion.hp,
          maxHp: minion.maxHp,
          state: minion.state,
          laneId: minion.laneId,
          laneDirection: minion.laneDirection,
          laneIndex: minion.laneIndex,
          targetId: minion.targetId,
          attackPhase: minion.attackPhase,
          attackTicks: minion.attackTicks,
          path: minion.path.map((step) => ({ ...step })),
          pathGoalKey: minion.pathGoalKey,
          moveProgress: minion.moveProgress
        })),
        mapInfo: {
          cells: activeMap.cells.size,
          lanes: (activeMap.lanes || []).map((lane) => lane ? lane.cells.length : 0),
          heroSpawns: {
            red: (activeMap.heroSpawns?.red || []).filter(Boolean).length,
            blue: (activeMap.heroSpawns?.blue || []).filter(Boolean).length
          }
        },
        nextWaveTick: game.nextWaveTick,
        spawnQueue: game.minionSpawnQueue.length,
        logs: game.logs.map((entry) => `${entry.tag}: ${entry.message}`)
      };
    },
    select(id) {
      if (!game.pieces[id]) return false;
      selectUnit(game.pieces[id]);
      return true;
    },
    moveTo(id, row, col) {
      const piece = game.pieces[id];
      if (!piece || game.status !== "playing") return false;
      const plan = makeMovePlan(piece, row, col);
      if (!plan) return false;
      game.selected = id;
      if (piece.state === "idle") issueMove(piece, plan);
      else applyReroute(piece, plan);
      return true;
    },
    setCell(id, row, col) {
      if (!inBounds(row, col)) return false;
      const piece = game.pieces[id];
      if (!piece) return false;
      piece.row = row;
      piece.col = col;
      piece.state = "idle";
      piece.path = [];
      piece.destination = null;
      piece.reroute = null;
      piece.moveProgress = 0;
      piece.recoveryTicks = 0;
      piece.attackTarget = null;
      piece.attackCharge = 0;
      piece.attackResume = null;
      piece.anim = null;
      piece.landedAt = null;
      renderPieces();
      syncAll(true);
      return true;
    },
    setHp(id, hp) {
      const piece = game.pieces[id];
      if (!piece) return false;

      const wasAlive = piece.hp > 0;
      piece.hp = Math.max(0, Math.min(piece.maxHp, hp));
      if (piece.hp <= 0 && wasAlive) {
        markDefeated(piece);
      }

      syncAll(true);
      return true;
    },
    setTowerHp(id, hp) {
      const tower = game.towers.find((entry) => entry.id === id);
      if (!tower) return false;
      const wasAlive = tower.hp > 0;
      tower.hp = Math.max(0, Math.min(tower.maxHp, hp));
      if (tower.hp <= 0 && wasAlive) {
        markDefeated(tower);
      }
      syncAll(true);
      return true;
    },
    restart: restartGame,
    forceWave() {
      if (game.status !== "playing") return false;
      game.nextWaveTick = game.tick;
      return true;
    },
    respawnSecondsAt(minutes) {
      return respawnSecondsForTime(Math.max(0, minutes) * 60000);
    },
    findPath(id, row, col) {
      const piece = game.pieces[id];
      return piece ? findPath(piece, row, col) : null;
    },
    plan(id, row, col) {
      const piece = game.pieces[id];
      return piece ? makeMovePlan(piece, row, col) : null;
    }
  };

  boot();
})();



