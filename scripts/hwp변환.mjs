// .hwp(한글 옛 형식) → .hwpx(한글 새 형식) 변환 도구 (양식 파일용: 표와 글 중심)
// 실행: node scripts/hwp변환.mjs <원본.hwp> <결과.hwpx> [--no-picture]
// 지원: 글자 모양(크기·굵게), 문단 정렬, 표(칸 합치기·크기·테두리·바탕색), 쪽 크기·여백, 그림 1개(그림 칸)
// 지원하지 않음: 머리말/꼬리말, 각주, 수식, 도형(그림 아닌 것), 글자별 서로 다른 모양(문단의 첫 모양만 사용)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { paraText, parseHwp, TAG } from "./hwp읽기.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TPL = join(ROOT, "scripts", "hwpx-template");
const tplText = (name) => readFileSync(join(TPL, name), "utf8");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ───────────── 1) 원본 읽기 ─────────────

/** 문서 정보(DocInfo): 테두리·글자 모양·문단 모양 */
function readDocInfo(recs) {
  const borderFills = [], charShapes = [], paraShapes = [];
  const colorOf = (n) => (n === 0xffffffff ? null : `#${[n & 255, (n >> 8) & 255, (n >> 16) & 255].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase().replace(/^(..)(..)(..)$/, "$3$2$1")}`);
  for (const r of recs) {
    const d = r.data;
    if (r.tag === 0x14) {
      // 테두리/배경: 그림 칸은 [종류, 굵기, 색]을 왼쪽·오른쪽·위·아래 순으로 6바이트씩 가진다
      const side = (i) => ({ type: d[2 + i * 6], width: d[3 + i * 6], color: d.readUInt32LE(4 + i * 6) });
      const fillType = d.length >= 36 ? d.readUInt32LE(32) : 0;
      const back = fillType & 1 && d.length >= 40 ? d.readUInt32LE(36) : 0xffffffff;
      borderFills.push({ left: side(0), right: side(1), top: side(2), bottom: side(3), fill: colorOf(back) });
    } else if (r.tag === 0x15) {
      charShapes.push({ height: d.readUInt32LE(42), bold: (d.readUInt32LE(46) & 2) !== 0, italic: (d.readUInt32LE(46) & 1) !== 0, color: d.readUInt32LE(52) });
    } else if (r.tag === 0x19) {
      paraShapes.push({ align: (d.readUInt32LE(0) >> 2) & 7 });
    }
  }
  return { borderFills, charShapes, paraShapes };
}

/** 본문: 위 단계 문단 → {글, 모양, 표, 그림} */
function readBody(recs) {
  const paras = [];
  let i = 0;
  const readPara = (startIdx, level) => {
    // startIdx는 PARA_HEADER. 이 문단의 글·글자모양을 읽고 다음 위치를 돌려준다
    const hd = recs[startIdx].data;
    const para = { text: "", paraShape: hd.readUInt16LE(8), charShape: 0, ctrls: [] };
    let k = startIdx + 1;
    while (k < recs.length && recs[k].level > level) {
      const r = recs[k];
      if (r.level === level + 1 && r.tag === TAG.PARA_TEXT) para.text = paraText(r.data);
      else if (r.level === level + 1 && r.tag === TAG.PARA_CHAR_SHAPE && r.data.length >= 8) para.charShape = r.data.readUInt32LE(4);
      else if (r.level === level + 1 && r.tag === TAG.CTRL_HEADER) {
        const id = r.data.subarray(0, 4).toString("latin1").split("").reverse().join("");
        const ctrl = { id, data: r.data, cells: [], table: null, shape: [] };
        k++;
        while (k < recs.length && recs[k].level > level + 1) {
          const q = recs[k];
          if (id === "tbl " && q.level === level + 2 && q.tag === TAG.TABLE) ctrl.table = q.data;
          else if (id === "tbl " && q.level === level + 2 && q.tag === TAG.LIST_HEADER) ctrl.cells.push({ hd: q.data, paras: [] });
          else if (id === "tbl " && q.level === level + 2 && q.tag === TAG.PARA_HEADER) {
            const [p, next] = readPara(k, level + 2);
            ctrl.cells[ctrl.cells.length - 1]?.paras.push(p);
            k = next;
            continue;
          } else ctrl.shape.push(q);
          k++;
        }
        para.ctrls.push(ctrl);
        continue;
      }
      k++;
    }
    return [para, k];
  };
  while (i < recs.length) {
    if (recs[i].tag === TAG.PARA_HEADER && recs[i].level === 0) {
      const [p, next] = readPara(i, 0);
      paras.push(p);
      i = next;
    } else i++;
  }
  return paras;
}

// ───────────── 2) hwpx 만들기 ─────────────

const BORDER_TYPE = { 0: "NONE", 1: "SOLID", 2: "DASH", 3: "DOT", 4: "DASH_DOT", 5: "DASH_DOT_DOT", 6: "LONG_DASH", 7: "CIRCLE", 8: "DOUBLE_SLIM", 9: "SLIM_THICK", 10: "THICK_SLIM", 11: "SLIM_THICK_SLIM" };
const BORDER_MM = ["0.1", "0.12", "0.15", "0.2", "0.25", "0.3", "0.4", "0.5", "0.6", "0.7", "1.0", "1.5", "2.0", "3.0", "4.0", "5.0"];
const ALIGN = { 0: "JUSTIFY", 1: "LEFT", 2: "RIGHT", 3: "CENTER", 4: "DISTRIBUTE", 5: "DISTRIBUTE_SPACE" };

function convert(srcPath, outPath, { withPicture = true } = {}) {
  const hwp = parseHwp(srcPath);
  const info = readDocInfo(hwp.docInfo);
  const sec = hwp.sections[0];
  const paras = readBody(sec.recs);
  const pageRec = sec.recs.find((r) => r.tag === TAG.PAGE_DEF);
  const page = pageRec
    ? { w: pageRec.data.readUInt32LE(0), h: pageRec.data.readUInt32LE(4), left: pageRec.data.readUInt32LE(8), right: pageRec.data.readUInt32LE(12), top: pageRec.data.readUInt32LE(16), bottom: pageRec.data.readUInt32LE(20), landscape: (pageRec.data.readUInt32LE(36) & 1) !== 0 }
    : { w: 59528, h: 84188, left: 8504, right: 8504, top: 5668, bottom: 4252, landscape: false };

  // 쓰인 모양만 새로 번호를 매긴다 (기본 틀: 테두리 1~2, 글자 0~6, 문단 0~19 → 그 뒤에 이어 붙임)
  const usedBF = new Map(), usedChar = new Map(), usedPara = new Map();
  const bfId = (hwpId) => { // hwp 번호는 1부터, 0이면 테두리 없음
    const key = hwpId > 0 && hwpId <= info.borderFills.length ? hwpId : 0;
    if (!usedBF.has(key)) usedBF.set(key, 3 + usedBF.size);
    return usedBF.get(key);
  };
  const charId = (hwpId) => { if (!usedChar.has(hwpId)) usedChar.set(hwpId, 7 + usedChar.size); return usedChar.get(hwpId); };
  const paraId = (hwpId) => { const a = info.paraShapes[hwpId]?.align ?? 1; if (!usedPara.has(a)) usedPara.set(a, 20 + usedPara.size); return usedPara.get(a); };

  let uid = 1000;
  const nextId = () => String(++uid);
  const paragraphXml = (p, runExtra = "") => {
    const lines = (p.text ?? "").split("\n");
    const runs = lines.map((t, n) => `<hp:run charPrIDRef="${charId(p.charShape)}">${n === 0 ? runExtra : ""}<hp:t>${esc(t)}</hp:t></hp:run>`);
    return `<hp:p id="${nextId()}" paraPrIDRef="${paraId(p.paraShape)}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs.join("<hp:lineBreak/>")}</hp:p>`;
  };

  const tableXml = (ctrl, inline) => {
    const t = ctrl.table;
    const rowCnt = t.readUInt16LE(4), colCnt = t.readUInt16LE(6);
    const cells = ctrl.cells.map((c) => {
      const d = c.hd;
      return {
        vert: (d.readUInt32LE(4) >> 5) & 3, col: d.readUInt16LE(8), row: d.readUInt16LE(10), cs: d.readUInt16LE(12), rs: d.readUInt16LE(14),
        w: d.readUInt32LE(16), h: d.readUInt32LE(20), bf: d.readUInt16LE(32), paras: c.paras,
      };
    });
    // 칸이 격자를 빈틈없이 채우는지 검사
    const occ = new Set();
    for (const c of cells) for (let r = 0; r < c.rs; r++) for (let k = 0; k < c.cs; k++) {
      const key = `${c.row + r},${c.col + k}`;
      if (occ.has(key)) throw new Error(`표 칸이 겹칩니다 (${key})`);
      occ.add(key);
    }
    if (occ.size !== rowCnt * colCnt) throw new Error(`표 칸 수가 맞지 않습니다: ${occ.size} / ${rowCnt * colCnt}`);
    const totalW = ctrl.data.readUInt32LE(16), totalH = ctrl.data.readUInt32LE(20);
    const trs = [];
    for (let r = 0; r < rowCnt; r++) {
      const tcs = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col).map((c) => {
        const body = (c.paras.length ? c.paras : [{ text: "", paraShape: 0, charShape: 0 }]).map((p) => paragraphXml(p)).join("");
        const va = ["TOP", "CENTER", "BOTTOM"][c.vert] ?? "CENTER";
        return (
          `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfId(c.bf)}">` +
          `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${va}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList>` +
          `<hp:cellAddr colAddr="${c.col}" rowAddr="${c.row}"/><hp:cellSpan colSpan="${c.cs}" rowSpan="${c.rs}"/><hp:cellSz width="${c.w}" height="${c.h}"/>` +
          `<hp:cellMargin left="141" right="141" top="0" bottom="0"/></hp:tc>`
        );
      });
      trs.push(`<hp:tr>${tcs.join("")}</hp:tr>`);
    }
    return (
      `<hp:tbl id="${nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${bfId(0)}" noAdjust="0">` +
      `<hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="${inline ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="0" bottom="0"/>${trs.join("")}</hp:tbl>`
    );
  };

  // 그림(그림 칸): 위치·크기는 원본 개체 정보, 내용은 BinData의 첫 그림
  const pictureXml = (ctrl, binName) => {
    const w = ctrl.data.readUInt32LE(16), h = ctrl.data.readUInt32LE(20);
    const vOff = ctrl.data.readUInt32LE(8), hOff = ctrl.data.readUInt32LE(12);
    const png = hwp.bins[binName];
    const pw = png.readUInt32BE(16), ph = png.readUInt32BE(20); // PNG 가로·세로 픽셀
    const dw = pw * 75, dh = ph * 75;
    return (
      `<hp:pic id="${nextId()}" zOrder="1" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${nextId()}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${dw}" height="${dh}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="${(w / dw).toFixed(6)}" e2="0" e3="0" e4="0" e5="${(h / dh).toFixed(6)}" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${dw}" y="0"/><hc:pt2 x="${dw}" y="${dh}"/><hc:pt3 x="0" y="${dh}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${dw}" top="0" bottom="${dh}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${dw}" dimheight="${dh}"/>` +
      `<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${vOff}" horzOffset="${hOff}"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`
    );
  };

  // 본문: 첫 문단에는 쪽 설정(secPr)이 들어간다
  let s = tplText("Contents/section0.xml");
  const open = /^[\s\S]*?<hs:sec\b[^>]*>/.exec(s)[0];
  const secPr = /<hp:secPr\b[\s\S]*?<\/hp:secPr>/.exec(s)[0].replace(
    /<hp:pagePr[^>]*><hp:margin[^>]*\/>/,
    `<hp:pagePr landscape="${page.landscape ? "NARROWLY" : "WIDELY"}" width="${page.w}" height="${page.h}" gutterType="LEFT_ONLY"><hp:margin header="0" footer="0" gutter="0" left="${page.left}" right="${page.right}" top="${page.top}" bottom="${Math.min(page.bottom || 3000, 3000)}"/>`,
  );
  const colCtrl = /<hp:ctrl>[\s\S]*?<\/hp:ctrl>/.exec(s)[0];
  const bodyParas = [];
  let usedPicture = false;
  paras.forEach((p, idx) => {
    let extra = idx === 0 ? `${secPr}${colCtrl}` : "";
    for (const c of p.ctrls) {
      if (c.id === "tbl ") extra += tableXml(c, true);
      else if (c.id === "gso " && withPicture && !usedPicture) {
        const bin = Object.keys(hwp.bins).find((n) => /\.png$/i.test(n));
        if (bin) { extra += pictureXml(c, bin); usedPicture = bin; }
      }
    }
    const hasText = p.text.replace(/\s/g, "").length > 0;
    if (!extra && !hasText && idx > 0) return; // 내용 없는 빈 문단은 건너뛴다
    bodyParas.push(paragraphXml(p, extra));
  });
  if (!bodyParas.length) throw new Error("본문에서 내용을 찾지 못했습니다.");
  const sectionXml = `${open}${bodyParas.join("")}</hs:sec>`;

  // 머리 정보(header.xml): 기본 틀에 테두리·글자·문단 모양을 덧붙인다
  let h = tplText("Contents/header.xml");
  const lineXml = (side, b) => {
    const type = BORDER_TYPE[b.type] ?? "SOLID";
    const none = b.type === 0 || type === "NONE";
    return `<hh:${side}Border type="${none ? "NONE" : type}" width="${none ? "0.1" : BORDER_MM[b.width] ?? "0.12"} mm" color="#000000"/>`;
  };
  const bfXml = (key, id) => {
    const b = key === 0 ? null : info.borderFills[key - 1];
    const none = { type: 0, width: 0 };
    return (
      `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
      `${lineXml("left", b?.left ?? none)}${lineXml("right", b?.right ?? none)}${lineXml("top", b?.top ?? none)}${lineXml("bottom", b?.bottom ?? none)}` +
      `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>` +
      (b?.fill && b.fill.toUpperCase() !== "#FFFFFF" ? `<hc:fillBrush><hc:winBrush faceColor="${b.fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : "") +
      `</hh:borderFill>`
    );
  };
  h = h.replace('<hh:borderFills itemCnt="2">', `<hh:borderFills itemCnt="${2 + usedBF.size}">`).replace("</hh:borderFills>", `${[...usedBF].map(([k, id]) => bfXml(k, id)).join("")}</hh:borderFills>`);

  const charPr = (id, cs) => {
    const color = `#${[cs.color & 255, (cs.color >> 8) & 255, (cs.color >> 16) & 255].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    return (
      `<hh:charPr id="${id}" height="${cs.height}" textColor="${color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
      `<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
      `<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
      `<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${cs.bold ? "<hh:bold/>" : ""}${cs.italic ? "<hh:italic/>" : ""}` +
      `<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`
    );
  };
  const dflt = { height: 1000, bold: false, italic: false, color: 0 };
  h = h.replace('<hh:charProperties itemCnt="7">', `<hh:charProperties itemCnt="${7 + usedChar.size}">`).replace(
    "</hh:charProperties>",
    `${[...usedChar].map(([k, id]) => charPr(id, info.charShapes[k] ?? dflt)).join("")}</hh:charProperties>`,
  );

  const para0 = /<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/.exec(h)?.[0];
  if (!para0) throw new Error("기본 틀의 문단 정의를 찾지 못했습니다.");
  const paraPr = (id, a) => para0.replace('id="0"', `id="${id}"`).replace('horizontal="JUSTIFY"', `horizontal="${ALIGN[a] ?? "LEFT"}"`).replace(/value="160"/g, 'value="120"');
  h = h.replace('<hh:paraProperties itemCnt="20">', `<hh:paraProperties itemCnt="${20 + usedPara.size}">`).replace(
    "</hh:paraProperties>",
    `${[...usedPara].map(([a, id]) => paraPr(id, a)).join("")}</hh:paraProperties>`,
  );

  // 꾸러미 만들기
  let hpf = tplText("Contents/content.hpf").replace("<opf:title/>", `<opf:title>${esc(outPath.replace(/^.*[\\/]/, "").replace(/\.hwpx$/, ""))}</opf:title>`).replaceAll("synthetic-fixture-author", "권리분석 에이전트");
  const files = { mimetype: [strToU8(tplText("mimetype")), { level: 0 }] };
  if (usedPicture) {
    hpf = hpf.replace('<opf:item id="settings"', '<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/><opf:item id="settings"');
    files["BinData/image1.png"] = new Uint8Array(hwp.bins[usedPicture]);
  }
  Object.assign(files, {
    "version.xml": strToU8(tplText("version.xml")),
    "settings.xml": strToU8(tplText("settings.xml")),
    "META-INF/container.xml": strToU8(tplText("META-INF/container.xml")),
    "META-INF/container.rdf": strToU8(tplText("META-INF/container.rdf")),
    "META-INF/manifest.xml": strToU8(tplText("META-INF/manifest.xml")),
    "Contents/content.hpf": strToU8(hpf),
    "Contents/header.xml": strToU8(h),
    "Contents/section0.xml": strToU8(sectionXml),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zipSync(files));
  const tableCount = paras.reduce((n, p) => n + p.ctrls.filter((c) => c.id === "tbl ").length, 0);
  const cellCount = paras.reduce((n, p) => n + p.ctrls.reduce((m, c) => m + c.cells.length, 0), 0);
  return { 표: tableCount, 칸: cellCount, 그림: usedPicture ? 1 : 0, 테두리모양: usedBF.size, 글자모양: usedChar.size, 문단모양: usedPara.size };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (args.length < 2) { console.error("사용법: node scripts/hwp변환.mjs <원본.hwp> <결과.hwpx> [--no-picture]"); process.exit(1); }
const result = convert(resolve(args[0]), resolve(args[1]), { withPicture: !process.argv.includes("--no-picture") });
console.log(`변환 완료: ${args[1]}`, JSON.stringify(result));
