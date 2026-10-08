"""Write verified PDF-space line rectangles, comments and a mindmap appendix to a new PDF.

Coordinates are unrotated PDF user units, exactly as returned by Zotero getPageData.
No guessed paragraph/keyword boundaries or bilingual counterpart annotations.
"""
import io
import json
import math
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DictionaryObject, NameObject, FloatObject,
                           NumberObject, TextStringObject, DecodedStreamObject)

COLORS = {
    'research_question': (1, .831, 0), 'method': (.18, .659, .898),
    'results': (.373, .698, .212), 'limitations': (1, .4, .4),
    'highlight': (.945, .596, .216),
}
LABELS = {'research_question': '研究问题', 'method': '研究方法', 'results': '主要结果',
          'limitations': '作者局限', 'highlight': '建议关注'}


def numbers(values):
    return ArrayObject([FloatObject(v) for v in values])


def add_annotation(writer, ann):
    rects = ann['rects']
    x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
    x1, y1 = max(r[2] for r in rects), max(r[3] for r in rects)
    color = COLORS[ann['category']]
    underline = ann['layer'] == 'L3'
    alpha = 1 if underline else .3
    annotation = DictionaryObject({
        NameObject('/Type'): NameObject('/Annot'),
        NameObject('/Subtype'): NameObject('/Underline' if underline else '/Highlight'),
        NameObject('/Rect'): numbers([x0, y0, x1, y1]),
        NameObject('/QuadPoints'): numbers([v for a, b, c, d in rects for v in [a, d, c, d, a, b, c, b]]),
        NameObject('/C'): numbers(color), NameObject('/CA'): FloatObject(alpha),
        NameObject('/F'): NumberObject(4), NameObject('/T'): TextStringObject('PaperPilot'),
        NameObject('/Contents'): TextStringObject(
            f"[PP·{LABELS[ann['category']]}] AI 分析：{ann.get('summary', '')}\n原文：{ann.get('quote', '')}"),
    })
    appearance = DecodedStreamObject()
    appearance.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                       NameObject('/BBox'): numbers([0, 0, x1-x0, y1-y0]),
                       NameObject('/Resources'): DictionaryObject({NameObject('/ExtGState'): DictionaryObject({
                           NameObject('/GS'): DictionaryObject({NameObject('/ca'): FloatObject(alpha),
                               NameObject('/CA'): FloatObject(alpha), NameObject('/BM'): NameObject('/Multiply')})})})})
    commands = ['q /GS gs', ' '.join(map(str, color)) + (' RG 1 w' if underline else ' rg')]
    for a, b, c, d in rects:
        if underline:
            commands.append(f'{a-x0} {b-y0+0.7} m {c-x0} {b-y0+0.7} l S')
        else:
            commands.append(f'{a-x0} {b-y0} {c-a} {d-b} re f')
    appearance.set_data(('\n'.join(commands) + '\nQ').encode('ascii'))
    annotation[NameObject('/AP')] = DictionaryObject({NameObject('/N'): writer._add_object(appearance)})
    writer.add_annotation(ann['page'], annotation)


def process_pdf(input_pdf_path, annotations, output_pdf_path, mindmap_path=None, guide=''):
    source, output = Path(input_pdf_path).resolve(), Path(output_pdf_path).resolve()
    if source == output:
        raise ValueError('不能覆盖原始 PDF，请使用新文件名')
    if output.exists():
        raise FileExistsError('目标文件已经存在，请使用新文件名')
    reader = PdfReader(source)
    if not annotations:
        raise ValueError('没有可可靠定位的标注')
    for ann in annotations:
        page = ann.get('page')
        if type(page) is not int or not 0 <= page < len(reader.pages):
            raise ValueError('标注页码无效')
        if ann.get('category') not in COLORS or ann.get('layer') not in ('L2', 'L3'):
            raise ValueError('标注类别或层级无效')
        if not ann.get('rects'):
            raise ValueError('标注坐标为空')
        for rect in ann['rects']:
            if len(rect) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in rect):
                raise ValueError('标注坐标无效')
            if rect[0] >= rect[2] or rect[1] >= rect[3]:
                raise ValueError('标注矩形无效')
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    layers = {'L2': 0, 'L3': 0}
    root = writer.add_outline_item('PaperPilot 阅读导航（AI 分析）', annotations[0]['page'])
    parents = {}
    for ann in annotations:
        add_annotation(writer, ann)
        layers[ann['layer']] += 1
        category = ann['category']
        if category not in parents:
            parents[category] = writer.add_outline_item(LABELS[category], ann['page'], parent=root)
        writer.add_outline_item(ann.get('summary', '')[:80] or ann.get('quote', '')[:80],
                                ann['page'], parent=parents[category])
    if guide:
        from pypdf.annotations import Text
        box = reader.pages[0].cropbox
        writer.add_annotation(0, Text(rect=(float(box.left)+12, float(box.top)-36,
                                           float(box.left)+36, float(box.top)-12), text=guide))
    if mindmap_path:
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        image = ImageReader(mindmap_path)
        width, height = image.getSize()
        buffer = io.BytesIO()
        drawing = canvas.Canvas(buffer, pagesize=(width/2, height/2))
        drawing.drawImage(image, 0, 0, width/2, height/2)
        drawing.save()
        writer.add_page(PdfReader(buffer).pages[0])
        writer.add_outline_item('PaperPilot 思维导图（附页）', len(writer.pages)-1, parent=root)
    buffer = io.BytesIO()
    writer.write(buffer)
    try:
        with output.open('xb') as stream:
            stream.write(buffer.getbuffer())
    except FileExistsError:
        raise
    except OSError:
        output.unlink(missing_ok=True)
        raise
    return {'annotated': len(annotations), 'layers': layers, 'mindmap': bool(mindmap_path), 'pages': len(writer.pages)}


def main():
    input_path, request_path, output_path, report_path = sys.argv[1:]
    try:
        request = json.loads(Path(request_path).read_text(encoding='utf8'))
        result = process_pdf(input_path, request['annotations'], output_path,
                             mindmap_path=request.get('mindmapPath'), guide=request.get('guide', ''))
        report = {'ok': True, **result}
        code = 0
    except Exception as exc:
        report = {'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
        code = 1
    Path(report_path).write_text(json.dumps(report, ensure_ascii=False), encoding='utf8')
    return code


if __name__ == '__main__':
    sys.exit(main())
