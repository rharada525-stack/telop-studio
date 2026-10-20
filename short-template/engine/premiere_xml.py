"""Premiere Pro が読み込める FCP7 XML (xmeml v4) を書き出す。"""
import os
from urllib.parse import quote
from xml.sax.saxutils import escape


def pathurl(path):
    real = os.path.realpath(path).replace("\\", "/")
    return "file://localhost/" + quote(real, safe="/:")


def _rate(fps):
    return f"<rate><timebase>{fps}</timebase><ntsc>FALSE</ntsc></rate>"


class XmlWriter:
    def __init__(self, fps, W, H):
        self.fps, self.W, self.H = fps, W, H
        self.file_ids = {}
        self.n_clip = 0

    def _file(self, path, dur, kind):
        if path in self.file_ids:
            return f'<file id="{self.file_ids[path]}"/>'
        fid = f"file-{len(self.file_ids) + 1}"
        self.file_ids[path] = fid
        if kind == "audio":
            media = ("<media><audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>"
                     "</samplecharacteristics><channelcount>2</channelcount></audio></media>")
        else:
            media = (f"<media><video><samplecharacteristics>{_rate(self.fps)}<width>{self.W}</width>"
                     f"<height>{self.H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square"
                     f"</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>"
                     f"</video></media>")
        return (f'<file id="{fid}"><name>{escape(os.path.basename(path))}</name>'
                f"<pathurl>{escape(pathurl(path))}</pathurl>{_rate(self.fps)}"
                f"<duration>{dur}</duration>{media}</file>")

    def clip(self, c):
        """c: name, path, start, end, kind(video|still|audio), zoom=(z0, z1)"""
        self.n_clip += 1
        dur = c["end"] - c["start"]
        parts = [f'<clipitem id="clipitem-{self.n_clip}">',
                 f"<name>{escape(c['name'])}</name><enabled>TRUE</enabled>",
                 f"<duration>{dur}</duration>{_rate(self.fps)}",
                 f"<start>{c['start']}</start><end>{c['end']}</end><in>0</in><out>{dur}</out>"]
        if c["kind"] == "video":
            parts.append("<alphatype>straight</alphatype>")
        parts.append(self._file(c["path"], dur, c["kind"]))
        if c["kind"] == "audio":
            parts.append("<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>")
        if c.get("zoom"):
            z0, z1 = c["zoom"]
            parts.append(
                "<filter><effect><name>Basic Motion</name><effectid>basic</effectid>"
                "<effectcategory>motion</effectcategory><effecttype>motion</effecttype>"
                "<mediatype>video</mediatype>"
                "<parameter authoringApp=\"PremierePro\"><parameterid>scale</parameterid><name>Scale</name>"
                f"<valuemin>0</valuemin><valuemax>1000</valuemax><value>{z0 * 100:.2f}</value>"
                f"<keyframe><when>0</when><value>{z0 * 100:.2f}</value></keyframe>"
                f"<keyframe><when>{dur}</when><value>{z1 * 100:.2f}</value></keyframe>"
                "</parameter></effect></filter>")
        parts.append("</clipitem>")
        return "".join(parts)

    def sequence(self, name, total, vtracks, atracks, markers):
        v = "".join("<track>" + "".join(self.clip(c) for c in tr) + "</track>" for tr in vtracks)
        a = "".join("<track>" + "".join(self.clip(c) for c in tr) + "</track>" for tr in atracks)
        mk = "".join(f"<marker><comment></comment><name>{escape(n)}</name><in>{f}</in><out>-1</out></marker>"
                     for f, n in markers)
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">'
            f'<sequence id="sequence-1"><name>{escape(name)}</name><duration>{total}</duration>'
            f"{_rate(self.fps)}<in>-1</in><out>-1</out>{mk}<media>"
            f"<video><format><samplecharacteristics>{_rate(self.fps)}<width>{self.W}</width>"
            f"<height>{self.H}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square"
            f"</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>"
            f"{v}</video>"
            "<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics>"
            "<depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>"
            f"{a}</audio></media></sequence></xmeml>\n")


def pack_lanes(clips):
    """重ならないようにトラック（レーン）へ詰める。"""
    lanes = []
    for c in sorted(clips, key=lambda c: c["start"]):
        for lane in lanes:
            if lane[-1]["end"] <= c["start"]:
                lane.append(c)
                break
        else:
            lanes.append([c])
    return lanes
