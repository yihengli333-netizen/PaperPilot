import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from pdf_annotator import process_pdf
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='PaperPilot 中文 ')
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / '原文.pdf'
        self.output = Path(self.tmp.name) / '批注.pdf'
        writer = PdfWriter()
        page = writer.add_blank_page(600, 800)
        page.cropbox = RectangleObject([10, 20, 590, 780])
        page.rotate(90)
        writer.add_outline_item('Original bookmark', 0)
        writer.add_metadata({'/Title': 'Original title'})
        writer.write(self.source)
        self.before = self.source.read_bytes()
        self.ann = dict(category='method', page=0, rects=[[20.25, 700.5, 100.75, 712.5], [320, 680, 410, 692]],
                        quote='Verified original sentence', summary='中文分析与批注', layer='L2')

    def run_pdf(self, annotations=None, **kwargs):
        return process_pdf(str(self.source), annotations if annotations is not None else [self.ann], str(self.output), **kwargs)

    def test_fractional_geometry_color_opacity_and_contents(self):
        report = self.run_pdf()
        reader = PdfReader(self.output)
        ann = reader.pages[0]['/Annots'][0].get_object()
        self.assertAlmostEqual(float(ann['/CA']), .3)
        self.assertAlmostEqual(float(ann['/C'][1]), .659)
        self.assertAlmostEqual(float(ann['/QuadPoints'][0]), 20.25)
        self.assertEqual(len(ann['/QuadPoints']), 16)
        self.assertIn('中文分析与批注', ann['/Contents'])
        self.assertIn('Verified original sentence', ann['/Contents'])
        self.assertTrue(ann['/AP']['/N'].get_object().get_data())
        self.assertEqual(report['annotated'], 1)
        self.assertEqual(report['layers'], {'L2': 1, 'L3': 0})

    def test_preserves_original_metadata_bookmarks_rotation_crop(self):
        self.run_pdf()
        reader = PdfReader(self.output)
        self.assertEqual(reader.metadata.title, 'Original title')
        self.assertEqual(reader.outline[0].title, 'Original bookmark')
        self.assertEqual(reader.pages[0].rotation, 90)
        self.assertEqual(list(reader.pages[0].cropbox), [10, 20, 590, 780])
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_no_automatic_bilingual_duplicate(self):
        self.ann['bilingual'] = True
        self.run_pdf()
        self.assertEqual(len(PdfReader(self.output).pages[0]['/Annots']), 1)

    def test_refuses_overwrite_and_same_source(self):
        with self.assertRaises(ValueError):
            process_pdf(str(self.source), [self.ann], str(self.source))
        self.output.write_bytes(b'existing output')
        with self.assertRaises(FileExistsError):
            self.run_pdf()
        self.assertEqual(self.output.read_bytes(), b'existing output')
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_rejects_empty_or_invalid_annotations_without_output(self):
        for bad in [[], [dict(self.ann, page=-1)], [dict(self.ann, layer='L1')],
                    [dict(self.ann, rects=[[0, 0, float('nan'), 9]])],
                    [dict(self.ann, rects=[[500, 700, 400, 712]])]]:
            with self.assertRaises(ValueError):
                self.run_pdf(bad)
            self.assertFalse(self.output.exists())

    def test_underlines_have_appearance_and_accurate_counts(self):
        report = self.run_pdf([dict(self.ann, layer='L3')])
        ann = PdfReader(self.output).pages[0]['/Annots'][0].get_object()
        self.assertEqual(ann['/Subtype'], '/Underline')
        self.assertEqual(report['layers'], {'L2': 0, 'L3': 1})
        self.assertIn(b' l S', ann['/AP']['/N'].get_object().get_data())

    def test_embeds_mindmap_appendix_and_guide(self):
        from PIL import Image
        image = Path(self.tmp.name) / '导图.png'
        Image.new('RGB', (1000, 600), 'white').save(image)
        report = self.run_pdf(mindmap_path=str(image), guide='阅读指引：点击高亮查看分析')
        reader = PdfReader(self.output)
        self.assertEqual(len(reader.pages), 2)
        self.assertTrue(reader.pages[-1]['/Resources']['/XObject'])
        self.assertIn('阅读指引', reader.pages[0]['/Annots'][-1].get_object()['/Contents'])
        self.assertTrue(report['mindmap'])


if __name__ == '__main__':
    unittest.main()
