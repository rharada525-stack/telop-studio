// FCP 7 XML Text generatorによる、文字と表示時間だけの読み込みテスト。
// 現行Premiereでの文字編集は未検証。ラボの装飾・アニメーションは出力しない。
// https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Applications/Applications.html
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const rate = '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>';
const parameter = (id, name, value) => `<parameter><parameterid>${id}</parameterid><name>${name}</name><value>${value}</value></parameter>`;

export function plainText(text) {
  // ブラウザプレビューの強調マーカーを外し、XML 1.0で使えない制御文字を除く。
  return String(text).replace(/[{}\[\]]/g, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
}

export function buildTextXml({ name = '演出ラボ_文字の読み込みテスト', W = 1920, H = 1080, items, fontName = 'Yu Gothic' }) {
  if (![W, H].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('画面サイズが不正です。');
  if (typeof fontName !== 'string' || !fontName.trim() || fontName.length > 200 || /[\u0000-\u001f]/.test(fontName)) throw new Error('フォント名が不正です。');
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('1〜100個の文字を指定してください。');
  const clips = items.map((item, index) => {
    const text = plainText(item.text ?? '');
    if (!text.trim() || text.length > 300) throw new Error('文字は1〜300文字で指定してください。');
    if (!Number.isFinite(item.t) || item.t < 0 || !Number.isFinite(item.d) || item.d <= 0 || item.t + item.d > 3600) throw new Error('表示時間が不正です。');
    const start = Math.round(item.t * 30), end = Math.round((item.t + item.d) * 30);
    if (end <= start) throw new Error('表示時間は1フレーム以上にしてください。');
    return { text, start, end, index };
  }).sort((a, b) => a.start - b.start);
  if (clips.some((clip, i) => i && clip.start < clips[i - 1].end)) throw new Error('文字の表示時間を重ねないでください。');
  const generators = clips.map(({ text, start, end, index }) => `<generatoritem id="text-${index + 1}">
<name>${esc(text.replace(/\n/g, ' '))}</name><duration>${end - start}</duration>${rate}
<in>0</in><out>${end - start}</out><start>${start}</start><end>${end}</end>
<enabled>TRUE</enabled><anamorphic>FALSE</anamorphic><alphatype>black</alphatype>
<effect id="text-effect-${index + 1}"><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype>
${parameter('str', 'Text', esc(text).replace(/\n/g, '&#13;'))}
${parameter('fontname', 'Font', esc(fontName.trim()))}
${parameter('fontsize', 'Size', String(Math.round(H * .075)))}
${parameter('fontstyle', 'Style', '2')}
${parameter('fontalign', 'Alignment', '2')}
${parameter('fontcolor', 'Font Color', '<alpha>255</alpha><red>255</red><green>255</green><blue>255</blue>')}
${parameter('origin', 'Origin', '<horiz>0</horiz><vert>0</vert>')}
</effect><sourcetrack><mediatype>video</mediatype></sourcetrack></generatoritem>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><sequence id="effects-lab-text-test">
<name>${esc(plainText(name))}</name><duration>${clips.at(-1).end}</duration>${rate}
<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media><video><format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
<track>${generators}<enabled>TRUE</enabled><locked>FALSE</locked></track></video></media>
</sequence></xmeml>\n`;
}
