import asyncio
import asyncpg

async def test_conn():
    try:
        conn = await asyncpg.connect(user='postgres', password='postgres',
                                   database='postgres', host='localhost', port=5433)
        print("Connection successful!")
        await conn.close()
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_conn())
