import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "check_sqlx_queries", Path(__file__).resolve().parents[1] / "check-sqlx-queries.py"
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class CheckedSqlxQueriesTests(unittest.TestCase):
    def test_checked_queries_are_allowed(self):
        for macro in CHECK.CHECKED:
            self.assertEqual(CHECK.violations(f'sqlx::{macro}!("SELECT 1", value)'), [])

    def test_runtime_and_unchecked_queries_are_rejected(self):
        for query in [
            'sqlx::query("SELECT 1")',
            'sqlx :: query_as::<_, Row>(sql)',
            'sqlx::query_scalar(sql)',
            'sqlx::query_unchecked!("SELECT 1")',
            'sqlx::query_file_as_unchecked!(Row, "file.sql")',
            'sqlx::query_with(sql, args)',
            'sqlx::raw_sql(sql)',
            'sqlx::QueryBuilder::new(sql)',
            'use sqlx::{PgPool, query as run};',
            'sqlx::query!("SELECT $1::text", value as _)',
            'sqlx::Executor::fetch_all(db, sqlx::query!("SELECT 1"))',
            'Executor::fetch_optional(db, checked_query)',
            'fn decode(row: sqlx::postgres::PgRow) {}',
            'use sqlx::Row;',
            'sqlx::Row::try_get(row, name)',
            'use sqlx::{PgPool, Row};',

        ]:
            self.assertTrue(CHECK.violations(query), query)

    def test_comments_literals_and_line_numbers(self):
        source = '''// sqlx::query(sql)
/* outer /* sqlx::query(sql) */ comment */
let sql = r##"SELECT 'sqlx::query(sql)'"##;
let text = "sqlx::query(sql)";
sqlx::query(sql);
'''
        self.assertEqual(CHECK.violations(source), [(5, "query")])


if __name__ == "__main__":
    unittest.main()
