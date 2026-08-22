import threading

from autoflow.services import PlatformServices


def test_concurrent_transactions_use_isolated_connections(tmp_path):
    services = PlatformServices(str(tmp_path / "data"))
    try:
        services.database.execute(
            "CREATE TABLE thread_probe(id INTEGER PRIMARY KEY, worker TEXT, seq INTEGER)"
        )
        errors: list[str] = []
        barrier = threading.Barrier(4)

        def worker(name: str) -> None:
            barrier.wait()
            try:
                for seq in range(25):
                    database = services.database
                    database.execute("BEGIN IMMEDIATE")
                    database.execute(
                        "INSERT INTO thread_probe(worker, seq) VALUES (?, ?)",
                        (name, seq),
                    )
                    database.execute("COMMIT")
            except Exception as exc:
                errors.append(f"{name}: {exc}")

        threads = [
            threading.Thread(target=worker, args=(f"w{index}",)) for index in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert errors == []
        count = services.database.execute(
            "SELECT COUNT(*) FROM thread_probe"
        ).fetchone()[0]
        assert count == 4 * 25
    finally:
        services.close()
