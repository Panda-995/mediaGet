"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface PseudoSpectrumProps {
  /** 播放中才跑动画；暂停 / 未播放时平滑落回一圈静止环 */
  playing?: boolean;
  className?: string;
}

/* ---------- 几何：一律按画布短边比例换算（1 单位 = 画布 1%） ---------- */
/** 画布相对封面方框的倍数，必须与 .mp-spectrum 的 width/height/left/top 一致。
    留到 1.2（而不是刚好包住音浪）是为了让最外层还有一圈余量，
    CSS 的 drop-shadow 光晕不至于被画布自身的边界硬切。 */
const FRAME = 1.2;
const BARS = 128; // 一圈音浪齿数，360° 均匀排布
const BAR_W = 0.009; // 齿宽：细齿，圆周上仍留约一半以上空隙
const COVER_R = 1 / (2 * FRAME); // 封面半径占画布短边的比例
/** 齿根半径 = 封面圆周本身（再往里咬 0.003，约半个像素）：
    齿是「内端直角 + 外端半圆」画的，所以内端就是一条落在封面圆周上的直边，
    128 根齿的根部串成一条与封面边缘完全同心的圆 → 严丝合缝。
    （不能用 lineCap: round：圆头端盖只有正中一个切点碰到圆周，两侧与齿间
     都会外移半个齿宽，看上去就是「没贴合」。）
    往里咬的这半个像素是为了盖住两段抗锯齿之间的缝，肉眼不可见，也不会盖住封面。 */
const INNER = COVER_R - 0.003;
const MIN_LEN = 0.006; // 最短齿（只剩根部一小截；须 > BAR_W/2，否则半圆外端会画反）
const MAX_LEN = 0.042; // 最长齿（齿根 + 最长齿尖 ≈ 0.456，离画布边缘还有余量）

/* ---------- 动态参数 ---------- */
const TAU = Math.PI * 2;
const BEAT = 1; // 鼓点间隔基准：约 1 秒一下
const BEAT_JITTER = 0.15; // 每拍时长 ±15% 抖动，避免机械感
const KICK_ATTACK = 0.045; // 鼓点脉冲的冲击时长（占一拍 4.5%，约 45ms）
const KICK_SHAPE = 2.4; // 之后收缩的曲线，越大"咚"得越干脆
const KICK_GAIN = 0.28; // 鼓点把波峰往外顶的高度（按波峰形状加权：峰上顶满，其余只跟 35%）
/* 电平以「暂停态静止环」（IDLE_LEVEL = 0.4）为标尺来定：
   常态必须留在同一量级，否则一播放大半圈会比停顿态还暗（alpha 掉到 0.1 上下），
   看着像被遮挡了；摆幅也必须够大——电平若只在 0.30~0.52 里晃，整圈齿长差不到
   1px，看着就是静止的。这里标称波谷 0.14 / 波峰 0.90，齿长比约 2.7 倍；
   实际谱型（见下面的 CREST_* 一段）摸到波峰 0.90、波谷落在 0.38，
   齿身长短仍差一倍往上，不会有一圈短齿糊成一片的时候。
   REST / SWING 对 128 根齿一视同仁：圆周上没有任何方位权重，每条弧的常态电平
   与摆幅完全一致，长短只由「图案转到了哪里」决定——转过去就轮到下一段。 */
const REST = 0.14; // 波谷电平（整圈共用，无方位权重）
const SWING = 0.76; // 波峰摆幅 → 波峰电平 0.90

/* 波峰的形状：齿长沿圆周怎么起伏。早先是一支「宽包」——四支谐波叠出来的、
   半高半宽约 46° 的圆鼓包。问题不在幅度而在形状：包太宽 → 任何时刻整圈都长得差不多，
   而波形又是刚性旋转（形状恒定，只整体绕圆心走），上一刻与下一刻几乎无从分辨，
   眼睛没有能咬住的记号，「在转」就完全读不出来。实测过：整圈齿长只差 6.3px，
   而每秒一次的鼓点会把整圈同时顶起 3.1px —— 慢转被这股整体呼吸彻底盖掉。
   所以波峰改成「窄尖峰 + 一道拖尾」，并且前后不对称：
     尖峰 —— 一个可以跟踪的记号，视线钉着它绕圈，转动才成立；
     不对称 —— 前缘陡、后缘拖得长（像水痕），转向一眼分清，不需要给齿加斜度。
   形状仍只是 φ = angle - spin 的函数：只由转角驱动，不掺时间噪声，
   所以整圈只是绕圆心走，没有哪一根会自己乱跳。
   下面 STAGGER_* 一段把这一支形状在整圈上放了两份（奇偶两组各一份），两份互
   错着走，于是「长短」是交错着变的，而不是一根接一根按顺序抬高再放下。 */
const CREST_LEAD = 0.42; // 前缘（顺转方向那一侧）的角宽 σ：约 24°，陡
const CREST_TAIL = 0.85; // 后缘（来处那一侧）的角宽 σ：约 49°，拖得长
const CREST_FLOOR = 0.32; // 波谷底噪：整圈都还留一圈短齿，且不低于暂停态的静止环（0.4）太多

/* ---------- 交错：奇偶两组齿各看「自己那支波」，峰沿圆周错开 ----------
   128 根齿按奇偶分成两组：偶数位（0,2,4…）看一支波，奇数位（1,3,5…）看另一支，
   两支形状完全一样（就是上面那支 CREST_*），只是波峰在圆周上错开 STAGGER。
   于是相邻两根永远落在各自波形的不同位置上 —— 一根正踩在自己那支的峰上、隔壁那根
   还在自己那支的半山腰 —— 整圈读出来就是「长、短、长、短」交错着走的一条波浪，
   而不是一根接一根按顺序抬高、放下的一片此起彼伏。错得最狠的地方（相邻两根落差
   最大）正好落在两个波峰附近，两支峰中间那段则平缓些，所以交错本身也有疏密。
   两支峰不是死锁的：错位量 STAGGER 会随转角缓慢摆动（STAGGER_WOB / _RATE）——
   两个峰时而靠近、时而拉开，「哪里长哪里短」因此一直在换，不会退化成一个固定图样
   来回重放。摆动幅度刻意留得小于 STAGGER（0.3 < 0.62），所以交错任何时刻都还在，
   只是疏密在变；两个峰的转速因此各带 ±9% 的缓慢起伏（WOB × RATE），肉眼看不出来，
   也没有任何随机抖动 —— 转动依旧是匀速、平滑、看得清的。
   把 STAGGER 调到很小（≈0.1）就退回「一支波扫过整圈」的旧样子；
   STAGGER_WOB 给 0 就是把错位锁死成一个固定的交错图样。 */
const STAGGER = 0.62; // 两组波峰的基础角错位（rad ≈ 36°）：越大，相邻两根的落差越明显
const STAGGER_WOB = 0.3; // 错位量沿圆周的缓慢摆动幅度（rad）：交错时疏时密，不锁成固定图样
const STAGGER_WOB_RATE = 0.29; // 摆动快慢（以转角计，与帧率无关）：约 18 秒一个来回

/** 全局旋转偏移的速度（rad/s）：每一帧把「过了多久」换算成绕圆心的转角
    —— spin = clock * SPIN，这就是那条「额外叠加的全局角度偏移」。
    整圈只有这一个转角：两组齿的波峰（CREST_* 那支形状）、色相环
    全都以它为准，所以「线条在转」和「颜色在转」永远是同一件事，不可能各转各的。
    正值 = 顺时针（与 i 递增同向：i = 0 在 12 点，往 3 点方向走）；
    改成负值就是逆时针，别的一行都不用动。约 5.2 秒一圈，
    想更慢给 0.6（10.5 秒一圈）、想更急给 1.6（约 4 秒一圈）。 */
const SPIN = 1.2;

/** 两组齿的波峰在画布上的角度（rad）：偶数位那组在 spin + stagger、奇数位那组在
    spin - stagger，两个峰因此沿圆周错开。stagger 随转角缓慢摆动 → 交错图样一直在换；
    但它只是 spin 的函数（不含时间噪声），所以整圈转得依旧匀速、平滑。 */
const staggerAt = (spin: number) => STAGGER + STAGGER_WOB * Math.sin(spin * STAGGER_WOB_RATE);
const crestOf = (i: number, spin: number) =>
  spin + (i & 1 ? -staggerAt(spin) : staggerAt(spin));

/* ---------- 配色：HSL 三通道各绑一个变量 ----------
   位置 → 色相：色相在圆周上按一个整周期正弦起伏（而不是 0~360 的线性斜坡——
     斜坡绕回起点处会留一道硬接缝），且绑的是「旋转坐标系里的位置」angle - spin，
     于是色带跟着音浪一起转：每根齿最浓的那一刻就是它自己最长的那一刻（奇偶两组
     各有一处，与它们的波峰严格重合），转过去才轮到下一段。
   振幅 → 饱和度 / 亮度：齿越长越浓、越亮，短齿淡而偏暗。
   时间 → 色相漂移：整体每秒缓移，整环像极光一样慢慢换色。
   色相一律以 --mp-primary 的色相为基准（亮暗两套主题各自不同），不写死颜色。 */
const HUE_SWING = 70; // 色相绕主题色摆动的幅度（度）：±70 → 总跨度 140°
const HUE_DRIFT = 16; // 时间维度的色相漂移（度/秒）
const SAT_BASE = 58; // 常态饱和度（%）
const SAT_GAIN = 34; // 振幅带来的饱和度增量（%）
const LIGHT_TIP = 46; // 齿尖亮度基准（%）
const LIGHT_GAIN = 30; // 振幅带来的亮度增量（%）
const LIGHT_ROOT = 0.42; // 齿根亮度 = 齿尖亮度 × 系数：根部深、尖端亮
const GLOW_GROW = 0.007; // 发光层比齿宽多出来的厚度（画布短边的比例）
const GLOW_GAIN = 0.18; // 发光层最亮时的叠加透明度

const DEFAULT_HUE = 226; // 解析不出主题色时的兜底色相（YesPlayMusic 蓝）
const ATTACK_TAU = 0.05; // 电平起：快（被鼓点顶一下）
const RELEASE_TAU = 0.16; // 电平落：慢
const IDLE_LEVEL = 0.4; // 暂停 / 未播放时落回的电平
const STILL_LEVEL = 0.55; // 用户偏好减弱动态效果时的静态电平
const REST_EPS = 0.004; // 电平收敛到这个差值就休眠，不再占着 rAF

/** 0~1 的整数哈希：给每拍时长一个稳定的伪随机抖动 */
function hash01(n: number) {
  let h = Math.imul(n + 0x9e37, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** 取 CSS 颜色的色相（度）。借 canvas 的 fillStyle 做归一化（它会把手写的颜色
    转成 "#rrggbb"），省得自己再写一套颜色语法解析；先用哨兵值占位，赋值被忽略
    （颜色不合法、fillStyle 没变）时就回落到默认色相。 */
function hueOf(css: string, ctx: CanvasRenderingContext2D) {
  const sentinel = "#123456";
  ctx.fillStyle = sentinel;
  ctx.fillStyle = css;
  if (ctx.fillStyle === sentinel) return DEFAULT_HUE;
  const m = /^#([0-9a-f]{6})$/i.exec(String(ctx.fillStyle).trim());
  if (!m) return DEFAULT_HUE;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return DEFAULT_HUE; // 灰阶没有色相
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * 圆封面外圈的「音浪」：原生 Canvas 画一圈 128 根放射状细齿。
 *
 * 齿的外形是「内端直角 + 外端半圆」：内端那条直边正好落在封面圆周上，
 * 128 根齿的根部因此串成一条与封面边缘完全同心的圆，严丝合缝（用圆头端盖做不到，
 * 端盖只有正中一个切点碰到圆周，齿间会露出一圈月亮形的缝）。所以实心齿是「填路径」
 * 而不是「描线」，lineCap: round 只用在下面那层发光上——它是虚的，端盖往里凸一点没关系。
 * 齿身一律沿半径长，没有任何切向斜度（早先给过一版「朝旋转后方偏 0.4」的斜齿，
 * 那套像风车的方向暗示已去掉）：整圈只剩「长短在转」这一件事。
 *
 * 不读任何音频文件，纯算法模拟。整圈波形是一支以波峰为中心的固定形状（见 CREST_*）：
 * 窄尖峰 + 一道拖尾，前缘陡、后缘长。这一支形状是「看得出在转」的关键，别随手改回
 * 「宽包」：早先那版是四支低频谐波叠出来的圆鼓包（半高半宽 46°），没有不对称，
 * 刚性旋转下上一刻与下一刻几乎无从分辨，看着就是整圈在原地呼吸。
 * 现在这一支形状在整圈上放了两份：
 *   奇偶两组齿各看自己那一支（见 STAGGER_*），两个峰沿圆周错开 —— 于是相邻两根
 *   一长一短交错着走，而不是一根接一根按顺序抬高再放下；错位量还会随转角缓慢摆动，
 *   所以「哪里长哪里短」一直在换，不会锁成一个固定图样反复重放；
 *   每根齿都只吃 φ = angle - spin，所以整圈照旧绕着圆心匀速转（约 5.2 秒一圈）、
 *   没有一格随机跳动；两个峰之间的距离缓慢地一开一合（约 18 秒一个来回），
 *   这就是「交错」本身在换花样。峰仍是可跟踪的记号：前后不对称给出转向，
 *   看得清在往哪边转。
 *   + 约每秒一次的鼓点脉冲（按各自那支波峰加权：峰上往外冲，其余部位只轻轻跟一下，
 *     不会整圈同时顶起把慢转盖掉）
 * 得到逐齿的目标电平后，再走一遍快起慢落的弹道平滑，长度/透明度都跟着走，
 * 所以伸缩是顺滑连续的，不会跳变。
 *
 * 配色走 HSL，三个变量各绑一个通道（常量区的说明更细）：
 *   位置（旋转坐标系）→ 色相、振幅 → 饱和度/亮度、时间 → 色相漂移；
 *   每根齿再从齿根到齿尖走一次径向渐变（根部深、尖端亮），
 *   外层再铺一遍 lineCap: round 的粗线做 "lighter" 发光。
 *
 * 整圈只有这一层：外圈原先叠过的几圈辉光环、以及骑在光环上的环绕光点都已删掉
 * （它们只是装饰，反而把「长短在变」这条主线冲淡了），最外那圈现在是空的。
 *
 * 圆周上仍然没有任何「长度向」的方位权重（早先「低频那侧弧度更大」的钟形山、以及
 * 长期偏向某几段的幅度纹理都已去掉）：128 条弧共用同一套常态电平与摆幅，奇偶交替
 * 也只是把它们分成两组、整圈均匀地分组，没有哪一段方位被固定抬高；某一刻哪一根长、
 * 哪一根短只取决于两支波转到了哪里，转过去就轮到下一根。
 *
 * 分层：齿根就压在封面边缘上（只往里咬半个像素盖住抗锯齿的缝），任何状态下都
 * 不会盖住封面本体（画布虽然画在封面之上，几何上却是「紧贴在外」；发光层同样是
 * "lighter" 叠加，一旦渗进封面上就会烧出一道亮边，所以它的端盖也退到了圆周之外）。
 *
 * 暂停 / 未选中曲目时电平平滑落回一圈静止环，落稳后主动停掉 rAF 不占 CPU；
 * `prefers-reduced-motion: reduce` 时只画一帧静止环，不做任何运动。
 */
export function PseudoSpectrum({ playing = true, className }: PseudoSpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(playing);
  const levelsRef = useRef<Float32Array | null>(null);
  const wakeRef = useRef<() => void>(() => {});

  // 播放态变化 → 唤醒动画帧循环（暂停时循环会自己落回静止态再休眠）
  useEffect(() => {
    playingRef.current = playing;
    wakeRef.current();
  }, [playing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const levels = levelsRef.current ?? new Float32Array(BARS).fill(IDLE_LEVEL);
    levelsRef.current = levels;

    let size = 0; // 画布短边（CSS px），也是整套几何的基准
    let dpr = 1;
    let offX = 0;
    let offY = 0;
    let baseHue = DEFAULT_HUE; // 主题色相：整圈配色的基准（亮暗主题各自不同）
    let clock = 0; // 只在运动时累加的时钟：暂停再播放时波形接着走，不跳变
    let spin = 0; // 当前的全局旋转偏移（rad）：只在 stepLevels 里推进，paint 读同一个值
    let beatT = 0; // 当前这一拍已经过了多少秒
    let beatLen = BEAT; // 当前这一拍的总时长
    let beatIdx = 0;
    let raf = 0;
    let last = performance.now();
    let disposed = false;

    /** 主题色（.mp-app 作用域里的 --mp-primary，亮暗主题各自不同）→ 只取色相 */
    const readColor = () => {
      const value = getComputedStyle(canvas).getPropertyValue("--mp-primary").trim();
      if (value) baseHue = hueOf(value, ctx);
    };

    /** 极角差 φ → 波峰形状因子（CREST_FLOOR ~ 1）：以波峰为中心的一段包，前缘陡、后缘长。
        必须先把 φ 折回 (-π, π] 再用：spin 是一直累加的（clock * SPIN 无上限），不折的话
        「在波峰前面还是后面」这个判断会随 spin 变大而失效——这里要靠正负号区分前后缘，
        所以必须真的取到那个最短角差（只做 cos() 的话无所谓，函数本身是周期的）。 */
    const crestAt = (phi: number) => {
      const m = ((phi % TAU) + TAU) % TAU;
      const q = m > Math.PI ? m - TAU : m;
      const sigma = q > 0 ? CREST_LEAD : CREST_TAIL;
      return CREST_FLOOR + (1 - CREST_FLOOR) * Math.exp((-0.5 * q * q) / (sigma * sigma));
    };

    /** 逐齿电平：定目标 → 快起慢落地逼近，起落都带时间常数，所以永远不会跳变 */
    const stepLevels = (running: boolean, dt: number) => {
      const still = motion.matches;

      // 走拍：每拍时长在 1s 上下抖动
      if (running) {
        clock += dt;
        beatT += dt;
        if (beatT >= beatLen) {
          beatT -= beatLen;
          beatIdx += 1;
          beatLen = BEAT * (1 - BEAT_JITTER + 2 * BEAT_JITTER * hash01(beatIdx * 31 + 7));
        }
      }

      // 鼓点脉冲：45ms 冲到顶，之后按曲线缓缓收回，正好铺满一整拍
      const phase = beatT / beatLen;
      const kick =
        phase < KICK_ATTACK
          ? phase / KICK_ATTACK
          : Math.pow(1 - (phase - KICK_ATTACK) / (1 - KICK_ATTACK), KICK_SHAPE);

      // 全局旋转偏移：整圈、逐帧只推进这一个转角（暂停时停在原地，
      // 电平自己落回静止环）。齿长图案与下面的色相环共用它，所以两者天然同步。
      spin = clock * SPIN;

      let alive = false;

      for (let i = 0; i < BARS; i++) {
        let target: number;

        if (running) {
          const angle = TAU * (i / BARS);

          // 旋转式音浪：把「时间」换成「转角」。每根齿看的都是 φ = angle - 它那一组的
          // 波峰角（见 crestOf / STAGGER_*），于是
          //   ① 刚性旋转：两组波形都只是 spin 的函数，整圈匀速绕圆心走，不会一边转
          //      一边变形（错位量的缓慢摆动也是 spin 的函数，所以不引入任何抖动）；
          //   ② 相邻两根分属两组、各自落在自己那支波形的不同位置 → 长短交错着走，
          //      不是一根接一根按顺序抬高再放下；
          //   ③ 波峰正好摸到 REST + SWING = 0.90。
          const phi = angle - crestOf(i, spin); // 相对「本组波峰」的角距离：0 = 正踩在峰上
          const shape = crestAt(phi);

          // 128 条弧共用同一个电平区间 [REST, REST + SWING]：长短只由两支波转到了
          // 哪里决定，圆周上没有哪一段被固定抬高（早先的幅度纹理与低频权重都会让
          // 某几段长时间偏大，已一并去掉）；奇偶只是整圈均匀地分成两组，也不带方位偏向。
          // 鼓点同样不整圈等量顶起，而是按各自那支波的峰加权：峰上跟着鼓点往外冲，
          // 其余部位只轻轻跟一下 —— 整圈同时顶起 3.1px 那股整体呼吸，正是把慢转盖掉的主因。
          target = Math.min(1, REST + SWING * shape + kick * KICK_GAIN * (0.35 + 0.65 * shape));
        } else {
          target = still ? STILL_LEVEL : IDLE_LEVEL;
        }

        const tau = target > levels[i] ? ATTACK_TAU : RELEASE_TAU;
        const next = levels[i] + (target - levels[i]) * (1 - Math.exp(-dt / tau));
        if (Math.abs(target - next) > REST_EPS) alive = true;
        levels[i] = next;
      }

      return running || alive;
    };

    /** 画一帧：先铺一层发光 → 再逐齿填一根「内端直角、外端半圆」的渐变色条 */
    const paint = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!size) return;

      ctx.setTransform(dpr, 0, 0, dpr, offX * dpr, offY * dpr);
      const center = size / 2;
      const root = size * INNER; // 齿根：正好压在封面圆周上
      const base = root + size * MIN_LEN;
      const span = size * (MAX_LEN - MIN_LEN);
      const w = Math.max(1, size * BAR_W); // 齿宽
      const r = w / 2; // 齿宽的一半，也是外端半圆的半径
      const grow = size * GLOW_GROW; // 发光层比齿宽多出来的厚度
      const drift = clock * HUE_DRIFT; // 时间维度：整环色相缓慢漂移

      // 第 i 根齿的色相 = 主题色相 + 位置（旋转坐标系，用的正是 stepLevels 推进的
      // 那个全局转角 spin；而且取的是「它那一组的波峰角」）+ 时间。这里用 cos、峰落在
      // 本组波峰上：最长的那根永远是最浓的一笔，色带和长短波浪是同一件东西在转；
      // 若写回 sin 就会错开 90°，看着像两圈各转各的。
      // 色相刻意不收窄（齿长那支已经是窄尖峰了）：整圈留一条平滑过渡的色带，
      // 才有那圈「颜色环」可看，尖峰这个记号交给长短去给。
      // 整周期，所以绕回起点处自然接上，不会出现一道硬接缝。
      const hueAt = (i: number) =>
        baseHue + HUE_SWING * Math.cos(TAU * (i / BARS) - crestOf(i, spin)) + drift;

      // ---- 第一层：发光 ----
      // 沿齿身描一条圆头粗线：lineCap round 用在这里正合适（它是虚的，端盖往里
      // 凸一点无所谓）；实心齿必须保持内端直角，理由见文件开头的几何说明。
      // 起点退到 root + r + grow，让端盖圆弧正好不越过封面圆周——这层是 "lighter"
      // 叠加，渗进封面就会在插画边缘烧出一道亮边。
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineWidth = w + grow * 2;
      for (let i = 0; i < BARS; i++) {
        const level = levels[i];
        const angle = (i / BARS) * TAU - Math.PI / 2;
        const tip = Math.max(base + span * level, root + r);
        const sat = SAT_BASE + SAT_GAIN * level;
        const light = Math.min(92, LIGHT_TIP + LIGHT_GAIN * level + 14);
        // 发光强度与长度同源：长齿才亮得起来
        const alpha = GLOW_GAIN * Math.pow(level, 1.5);
        ctx.strokeStyle = `hsla(${Math.round(hueAt(i))}, ${Math.round(sat)}%, ${Math.round(light)}%, ${alpha})`;
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(angle); // 局部坐标里齿沿 +x 向外长
        // 齿身就是一条沿半径的直线（不外偏）：起点退到 root + r + grow
        ctx.beginPath();
        ctx.moveTo(root + r + grow, 0);
        ctx.lineTo(tip - r, 0);
        ctx.stroke();
        ctx.restore();
      }

      // ---- 第二层：实心齿 ----
      ctx.globalCompositeOperation = "source-over";
      for (let i = 0; i < BARS; i++) {
        const level = levels[i];
        // 从正上方（12 点）开始顺时针，与 BASS 的「前 1/4」方位一致
        const angle = (i / BARS) * TAU - Math.PI / 2;
        // 齿尖至少留到「齿根 + 半圆半径」，避免极短齿把外形画反
        const tip = Math.max(base + span * level, root + r);

        // 根 → 尖的径向渐变：色相随位置/时间走，饱和度与亮度随振幅走。
        // 渐变写在齿的局部坐标里（就是沿半径那条轴），canvas 会在填充时套用当时的
        // 变换，所以每根齿都拿到自己的那段渐变。
        const hue = hueAt(i);
        const sat = SAT_BASE + SAT_GAIN * level;
        const light = LIGHT_TIP + LIGHT_GAIN * level;
        const grad = ctx.createLinearGradient(root, 0, tip, 0);
        grad.addColorStop(
          0,
          `hsla(${Math.round(hue)}, ${Math.round(sat * 0.82)}%, ${Math.round(light * LIGHT_ROOT)}%, 0.55)`,
        );
        grad.addColorStop(1, `hsla(${Math.round(hue)}, ${Math.round(sat)}%, ${Math.round(light)}%, 1)`);

        // 透明度与长度同源：长则亮、短则几乎隐入背景（level^1.5 让短齿落得更快）
        ctx.globalAlpha = 0.03 + 0.97 * Math.pow(level, 1.5);
        ctx.fillStyle = grad;
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(root, -r); // 内端直角：两个角仍然钉在封面圆周上
        ctx.lineTo(tip - r, -r);
        ctx.arc(tip - r, 0, r, -Math.PI / 2, Math.PI / 2); // 外端半圆
        ctx.lineTo(root, r);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, Math.max(0.004, (now - last) / 1000));
      last = now;
      const running = playingRef.current && !motion.matches && canvas.offsetWidth > 0;
      const alive = stepLevels(running, dt);
      paint();
      if (alive) raf = requestAnimationFrame(tick);
    };

    /** 唤醒（已在跑就什么都不做） */
    const wake = () => {
      if (disposed || raf) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    /** 画布尺寸跟随封面（CSS 给 120% 的方框），按 dpr 出图保证清晰 */
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(0, rect.width);
      const h = Math.max(0, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = Math.min(w, h);
      offX = (w - size) / 2;
      offY = (h - size) / 2;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      readColor();
      paint();
      wake(); // 从 display:none / 极窄视口恢复回来时，把休眠的循环叫醒
    };

    /** 亮暗主题切换（html 上的 .dark / .light）→ 换色重画 */
    const syncTheme = () => {
      readColor();
      paint();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    motion.addEventListener("change", wake);

    resize();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      themeObserver.disconnect();
      motion.removeEventListener("change", wake);
      wakeRef.current = () => {};
    };
  }, []);

  return <canvas ref={canvasRef} className={cn("mp-spectrum", className)} aria-hidden="true" />;
}
