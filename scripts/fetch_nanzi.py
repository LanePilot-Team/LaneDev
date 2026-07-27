# -*- coding: utf-8 -*-
"""抓楠梓區 OSM 資料 → public/data/*.geojson

Base Layer 備援路徑（LanePilot 楠梓 shard 取得後可改吃 shard，見計畫書 B-3）。
- 楠梓區 = OSM relation 2106299 → Overpass area 3602106299
- 道路：全區可行車道路（不含 service / 人行 / 自行車道）
- 建築：demo 區域 bbox（大學南路/德中路一帶），供 3D 城市感
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data"

NANZI_AREA = 3602106299

ROAD_QUERY = f"""
[out:json][timeout:180];
area({NANZI_AREA})->.a;
way(area.a)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];
out geom;
"""

# demo 區域：大學南路 / 德中路 / 高雄大學一帶（annotations.jsonl 已有標註的區域）
BUILDING_BBOX = (22.720, 120.264, 22.740, 120.292)
BUILDING_QUERY = f"""
[out:json][timeout:180];
way["building"]({",".join(str(x) for x in BUILDING_BBOX)});
out geom;
"""

ROAD_TAGS = [
    "name", "highway", "lanes", "lanes:forward", "lanes:backward",
    "oneway", "maxspeed", "turn:lanes", "turn:lanes:forward",
    "turn:lanes:backward", "bridge", "layer", "motorcycle",
]


def overpass(query: str) -> dict:
    data = ("data=" + urllib.parse.quote(query)).encode("utf-8")
    req = urllib.request.Request(OVERPASS, data=data, headers={
        "User-Agent": "nav-simulator/0.2 (CSIE capstone; contact: deu.2046@gmail.com)"
    })
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def way_to_feature(el: dict, keep_tags: list[str] | None) -> dict:
    tags = el.get("tags", {})
    props = {"osm_id": el["id"]}
    if keep_tags is None:
        props.update(tags)
    else:
        for k in keep_tags:
            if k in tags:
                props[k.replace(":", "_")] = tags[k]
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {
            "type": "LineString",
            "coordinates": [[p["lon"], p["lat"]] for p in el["geometry"]],
        },
        # 拓撲用：與其他 way 共用的 node id 代表相連（graph 建置需要）
        "id": el["id"],
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("fetching roads ...")
    roads_raw = overpass(ROAD_QUERY)
    road_features = []
    for el in roads_raw["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        f = way_to_feature(el, ROAD_TAGS)
        f["properties"]["nodes"] = el["nodes"]  # graph 拓撲
        road_features.append(f)
    roads = {"type": "FeatureCollection", "features": road_features}
    (OUT_DIR / "nanzi_roads.geojson").write_text(
        json.dumps(roads, ensure_ascii=False), encoding="utf-8")
    print(f"  roads: {len(road_features)} ways")

    time.sleep(2)  # Overpass 禮貌間隔

    print("fetching buildings (demo bbox) ...")
    b_raw = overpass(BUILDING_QUERY)
    b_features = []
    for el in b_raw["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        tags = el.get("tags", {})
        levels = tags.get("building:levels")
        try:
            height = float(tags.get("height", 0)) or (float(levels) * 3.2 if levels else 0)
        except ValueError:
            height = 0
        b_features.append({
            "type": "Feature",
            "properties": {"height": height or 8.0},
            "geometry": {"type": "Polygon", "coordinates": [coords]},
        })
    buildings = {"type": "FeatureCollection", "features": b_features}
    (OUT_DIR / "nanzi_buildings.geojson").write_text(
        json.dumps(buildings, ensure_ascii=False), encoding="utf-8")
    print(f"  buildings: {len(b_features)}")

    meta = {
        "source": "Overpass API (openstreetmap.org, ODbL)",
        "area": "楠梓區 (relation 2106299)",
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "roads": len(road_features),
        "buildings": len(b_features),
        "building_bbox": BUILDING_BBOX,
    }
    (OUT_DIR / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("done.")


if __name__ == "__main__":
    main()
