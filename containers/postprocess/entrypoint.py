"""Fargate post-process entrypoint.

Reads the task record from DynamoDB, downloads the raw GLB from the work
bucket, runs Blender headless to convert formats and render a thumbnail, and
uploads the results to the model-assets bucket at the web-app's key
convention:

    model-assets/{user_id}/{job_id}.glb
    model-assets/{user_id}/{job_id}.fbx / .obj / .usdz   (as requested)
    model-assets/{user_id}/{job_id}-thumbnail.jpg

Environment (set by the ECS task definition / Step Functions override):
    TASK_ID, TASKS_TABLE, WORK_BUCKET, ASSETS_BUCKET
"""

import json
import os
import subprocess
import sys
import tempfile

import boto3

CONTENT_TYPES = {
    "glb": "model/gltf-binary",
    "fbx": "application/octet-stream",
    "obj": "text/plain",
    "usdz": "model/vnd.usdz+zip",
    "jpg": "image/jpeg",
}

DEFAULT_FORMATS = ["glb", "fbx", "obj", "usdz"]


def get_task(table_name: str, task_id: str) -> dict:
    table = boto3.resource("dynamodb").Table(table_name)
    item = table.get_item(Key={"pk": f"TASK#{task_id}"}).get("Item")
    if not item:
        raise SystemExit(f"task {task_id} not found in {table_name}")
    return item


def main() -> None:
    task_id = os.environ["TASK_ID"]
    work_bucket = os.environ["WORK_BUCKET"]
    assets_bucket = os.environ["ASSETS_BUCKET"]

    task = get_task(os.environ["TASKS_TABLE"], task_id)
    user_id = task["user_id"]
    job_id = task["job_id"]
    artifact_prefix = task.get("artifact_prefix") or f"tasks/{task_id}"
    formats = list(task.get("options", {}).get("formats") or DEFAULT_FORMATS)
    if "glb" not in formats:
        formats.insert(0, "glb")

    s3 = boto3.client("s3")

    with tempfile.TemporaryDirectory() as tmp:
        raw_glb = os.path.join(tmp, "model.glb")
        s3.download_file(work_bucket, f"{artifact_prefix}/raw/model.glb", raw_glb)

        out_dir = os.path.join(tmp, "out")
        os.makedirs(out_dir)
        spec = {
            "input": raw_glb,
            "out_dir": out_dir,
            "name": job_id,
            "formats": formats,
            "thumbnail": True,
        }
        spec_path = os.path.join(tmp, "spec.json")
        with open(spec_path, "w") as f:
            json.dump(spec, f)

        subprocess.run(
            [
                "blender",
                "--background",
                "--factory-startup",
                "--python",
                "/app/convert.py",
                "--",
                spec_path,
            ],
            check=True,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )

        key_prefix = f"model-assets/{user_id}/{job_id}"
        uploaded = []
        for fmt in formats:
            path = os.path.join(out_dir, f"{job_id}.{fmt}")
            if fmt == "glb":
                # The GLB is authoritative from inference; pass it through untouched.
                path = raw_glb
            if not os.path.exists(path):
                print(f"warning: expected output missing for format {fmt}", file=sys.stderr)
                continue
            key = f"{key_prefix}.{fmt}"
            s3.upload_file(
                path, assets_bucket, key, ExtraArgs={"ContentType": CONTENT_TYPES[fmt]}
            )
            uploaded.append(key)

        thumb = os.path.join(out_dir, f"{job_id}-thumbnail.jpg")
        if os.path.exists(thumb):
            key = f"{key_prefix}-thumbnail.jpg"
            s3.upload_file(
                thumb, assets_bucket, key, ExtraArgs={"ContentType": CONTENT_TYPES["jpg"]}
            )
            uploaded.append(key)

        print(f"uploaded: {json.dumps(uploaded)}")


if __name__ == "__main__":
    main()
