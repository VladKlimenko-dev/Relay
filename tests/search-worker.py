"""Focused worker tests; no external engine requests."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("worker", pathlib.Path(__file__).resolve().parents[1] / "setup/search-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SearchTests(unittest.TestCase):
    def test_fallback_domains_unicode_and_tls(self):
        calls = []

        class Engine:
            def __init__(self, **kwargs):
                self.options = kwargs

            def text(self, query, **kwargs):
                calls.append((query, kwargs, self.options))
                if kwargs["backend"] == "duckduckgo":
                    raise RuntimeError("blocked")
                return [
                    {"title": "bad", "href": "https://docs.python.org.evil.invalid/x"},
                    {"title": "bad", "href": "javascript:alert(1)"},
                    {"title": "bad", "href": "https://user:pass@docs.python.org/x"},
                    {"title": "Документы", "href": "https://docs.python.org/3/", "body": "Пути"},
                    {"title": "duplicate", "href": "https://docs.python.org/3/"},
                ]
        r = worker.search_request({"query": 'Python пути "$(echo no)"', "sites": ["docs.python.org"], "max": 1}, Engine)
        self.assertEqual(len(r["results"]), 1)
        self.assertEqual(r["results"][0]["title"], "Документы")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]["region"], "ru-ru")
        self.assertTrue(calls[0][2]["verify"])
        self.assertIn('$(echo no)', calls[0][0])

    def test_empty_is_failure(self):
        class Empty:
            def __init__(self, **kwargs):
                pass
            def text(self, *args, **kwargs):
                return []
        self.assertIn("error", worker.search_request({"query": "no matches"}, Empty))

    def test_validation(self):
        for request in [{"query": "x"}, {"query": "x" * 401}, {"query": "okay", "sites": ["evil/host"]}]:
            with self.assertRaises(ValueError):
                worker.search_request(request, object)


unittest.main()
