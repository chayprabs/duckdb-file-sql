import argparse
import math
from pathlib import Path

import duckdb


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an uncompressed Parquet benchmark fixture near a target size.")
    parser.add_argument("--output", required=True, help="Target parquet file path")
    parser.add_argument("--target-bytes", required=True, type=int, help="Desired parquet file size in bytes")
    parser.add_argument("--payload-repeat", default=12, type=int, help="Times to repeat the md5 payload per row")
    parser.add_argument(
        "--min-ratio",
        default=0.98,
        type=float,
        help="Minimum acceptable output size ratio relative to target bytes",
    )
    parser.add_argument(
        "--max-ratio",
        default=1.10,
        type=float,
        help="Maximum acceptable output size ratio relative to target bytes",
    )
    return parser.parse_args()


def estimate_rows(target_bytes: int, payload_repeat: int) -> int:
    approx_row_bytes = 96 + (32 * payload_repeat)
    return max(10_000, math.ceil(target_bytes / approx_row_bytes))


def build_query(rows: int, payload_repeat: int) -> str:
    return f"""
        COPY (
            SELECT
                i AS row_id,
                i % 1000 AS bucket,
                md5(i::VARCHAR) AS hash_value,
                repeat(md5((i * 17)::VARCHAR), {payload_repeat}) AS payload
            FROM range({rows}) AS input(i)
        )
        TO ? (FORMAT PARQUET, COMPRESSION uncompressed, ROW_GROUP_SIZE 100000)
    """


def generate_fixture(output_path: Path, target_bytes: int, payload_repeat: int, min_ratio: float, max_ratio: float) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rows = estimate_rows(target_bytes, payload_repeat)
    connection = duckdb.connect()
    try:
        for _ in range(6):
            if output_path.exists():
                output_path.unlink()

            connection.execute(build_query(rows, payload_repeat), [output_path.as_posix()])
            size_bytes = output_path.stat().st_size
            ratio = size_bytes / target_bytes
            if min_ratio <= ratio <= max_ratio:
                return size_bytes

            rows = max(100_000, math.ceil(rows * (target_bytes / size_bytes) * 1.02))
    finally:
        connection.close()

    return output_path.stat().st_size


def main() -> None:
    args = parse_args()
    output_path = Path(args.output)
    size_bytes = generate_fixture(
        output_path=output_path,
        target_bytes=args.target_bytes,
        payload_repeat=args.payload_repeat,
        min_ratio=args.min_ratio,
        max_ratio=args.max_ratio,
    )
    print(f"{output_path} {size_bytes}")


if __name__ == "__main__":
    main()
