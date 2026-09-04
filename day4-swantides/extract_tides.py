#!/usr/bin/env python3
"""
Extract tide data for all 40 Western Australia locations from
MAR_P_2026_Tide_Predictions_by_Location_WA2.pdf.
Outputs individual JSON files for each location and a locations.json index.
"""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime

try:
    import fitz  # PyMuPDF
except ImportError:
    print("ERROR: PyMuPDF (fitz) required. Run: pip install pymupdf")
    sys.exit(1)

PDF_PATH = "MAR_P_2026_Tide_Predictions_by_Location_WA2.pdf"
YEAR = 2026

# List of all 40 locations in order of appearance (pages 3-122, 3 pages each)
LOCATIONS_CONFIG = [
    {"slug": "albany", "name": "Albany", "pages": (2, 3, 4)},
    {"slug": "augusta", "name": "Augusta", "pages": (5, 6, 7)},
    {"slug": "barrow_tanker", "name": "Barrow Island (Tanker Mooring)", "pages": (8, 9, 10)},
    {"slug": "barrow_wapet", "name": "Barrow Island (Wapet Landing)", "pages": (11, 12, 13)},
    {"slug": "bremer_bay", "name": "Bremer Bay", "pages": (14, 15, 16)},
    {"slug": "broome", "name": "Broome", "pages": (17, 18, 19)},
    {"slug": "bunbury", "name": "Bunbury", "pages": (20, 21, 22)},
    {"slug": "caddadup", "name": "Caddadup", "pages": (23, 24, 25)},
    {"slug": "cape_bouvard", "name": "Cape Bouvard", "pages": (26, 27, 28)},
    {"slug": "cape_domett", "name": "Cape Domett", "pages": (29, 30, 31)},
    {"slug": "cape_voltaire", "name": "Cape Voltaire (Krait Bay)", "pages": (32, 33, 34)},
    {"slug": "carnarvon", "name": "Carnarvon", "pages": (35, 36, 37)},
    {"slug": "coral_bay", "name": "Coral Bay (Ningaloo Reef)", "pages": (38, 39, 40), "dtmi": True},
    {"slug": "cowaramup", "name": "Cowaramup Bay", "pages": (41, 42, 43), "dtmi": True},
    {"slug": "dampier", "name": "Dampier (King Bay)", "pages": (44, 45, 46)},
    {"slug": "denham", "name": "Denham", "pages": (47, 48, 49)},
    {"slug": "derby", "name": "Derby", "pages": (50, 51, 52)},
    {"slug": "esperance", "name": "Esperance", "pages": (53, 54, 55)},
    {"slug": "exmouth", "name": "Exmouth", "pages": (56, 57, 58)},
    {"slug": "fremantle", "name": "Fremantle", "pages": (59, 60, 61)},
    {"slug": "geraldton", "name": "Geraldton", "pages": (62, 63, 64)},
    {"slug": "harvey", "name": "Harvey", "pages": (65, 66, 67)},
    {"slug": "hillarys", "name": "Hillarys", "pages": (68, 69, 70)},
    {"slug": "jurien_bay", "name": "Jurien Bay", "pages": (71, 72, 73)},
    {"slug": "mandurah", "name": "Mandurah (Ocean Marina)", "pages": (74, 75, 76)},
    {"slug": "monkey_mia", "name": "Monkey Mia (Shark Bay)", "pages": (77, 78, 79), "dtmi": True},
    {"slug": "napier_broome", "name": "Napier Broome Bay", "pages": (80, 81, 82), "dtmi": True},
    {"slug": "onslow", "name": "Onslow (Beadon Creek)", "pages": (83, 84, 85)},
    {"slug": "peel_inlet", "name": "Peel Inlet", "pages": (86, 87, 88)},
    {"slug": "barrack", "name": "Perth (Barrack Street Jetty)", "pages": (89, 90, 91)},
    {"slug": "port_geographe", "name": "Port Geographe (Busselton)", "pages": (92, 93, 94)},
    {"slug": "port_hedland", "name": "Port Hedland", "pages": (95, 96, 97)},
    {"slug": "port_walcott", "name": "Port Walcott (Cape Lambert)", "pages": (98, 99, 100)},
    {"slug": "shale_island", "name": "Shale Island (Collier Bay)", "pages": (101, 102, 103), "dtmi": True},
    {"slug": "tantabiddi", "name": "Tantabiddi (Ningaloo Reef)", "pages": (104, 105, 106), "dtmi": True},
    {"slug": "thevenard", "name": "Thevenard Island", "pages": (107, 108, 109)},
    {"slug": "two_rocks", "name": "Two Rocks Marina", "pages": (110, 111, 112)},
    {"slug": "woodbridge", "name": "Woodbridge (Swan River)", "pages": (113, 114, 115), "dtmi": True},
    {"slug": "wyndham", "name": "Wyndham", "pages": (116, 117, 118)},
    {"slug": "yampi_sound", "name": "Yampi Sound (Koolan Island)", "pages": (119, 120, 121)}
]


def parse_merged_text(text):
    """Handle merged tokens like 'TU1413' -> ['TU', '1413']."""
    match = re.match(r'^([A-Z]{2,3})(\d{4})$', text)
    if match:
        return [match.group(1), match.group(2)]
    return [text]


def extract_from_words(words, month_idx):
    """Extract tides from a sorted column of word tokens."""
    words.sort(key=lambda w: (round(w['top'], 1), round(w['x0'], 1)))
    entries = []
    current_day = None

    tokens_stream = []
    for w in words:
        for t in parse_merged_text(w['text']):
            tokens_stream.append({'text': t, 'top': w['top'], 'x0': w['x0']})

    i = 0
    while i < len(tokens_stream):
        token = tokens_stream[i]['text']

        # Day token (e.g. '1' or '01' up to '31')
        if token.isdigit() and len(token) <= 2 and 1 <= int(token) <= 31:
            current_day = int(token)
            i += 1
            continue

        # Time token: exactly 4 digits 'HHMM'
        if re.match(r'^\d{4}$', token):
            time_str = token
            if i + 1 < len(tokens_stream):
                next_token = tokens_stream[i + 1]['text']
                try:
                    height = float(next_token)
                    if -1.0 <= height <= 16.0 and current_day is not None:
                        try:
                            d = date(YEAR, month_idx + 1, current_day)
                            entries.append({
                                'date': d.isoformat(),
                                'time': f"{time_str[:2]}:{time_str[2:]}",
                                'height': height
                            })
                            i += 2
                            continue
                        except ValueError:
                            pass
                except ValueError:
                    pass

        i += 1

    return entries


def extract_location(doc, config):
    """Extract all tides for a location across its 3 pages."""
    is_dtmi = config.get("dtmi", False)
    pages = config["pages"]

    if is_dtmi:
        subcols_left = [(40, 105), (105, 167), (167, 229), (229, 295)]
        subcols_right = [(300, 363), (363, 425), (425, 487), (487, 555)]
        y_top = (100, 450)
        y_bot = (460, 820)
    else:
        subcols_left = [(30, 95), (95, 160), (160, 225), (225, 290)]
        subcols_right = [(300, 365), (365, 430), (430, 495), (495, 560)]
        y_top = (110, 415)
        y_bot = (425, 735)

    all_entries = []

    for p_offset, page_no in enumerate(pages):
        p = doc[page_no]
        words_raw = p.get_text("words")
        words = [{'x0': w[0], 'top': w[1], 'text': w[4]} for w in words_raw]
        base_m = p_offset * 4

        # Month 1 of page (top-left)
        for (x_min, x_max) in subcols_left:
            col_words = [w for w in words if x_min <= w['x0'] < x_max and y_top[0] <= w['top'] < y_top[1]]
            all_entries.extend(extract_from_words(col_words, base_m))

        # Month 2 of page (top-right)
        for (x_min, x_max) in subcols_right:
            col_words = [w for w in words if x_min <= w['x0'] < x_max and y_top[0] <= w['top'] < y_top[1]]
            all_entries.extend(extract_from_words(col_words, base_m + 1))

        # Month 3 of page (bottom-left)
        for (x_min, x_max) in subcols_left:
            col_words = [w for w in words if x_min <= w['x0'] < x_max and y_bot[0] <= w['top'] < y_bot[1]]
            all_entries.extend(extract_from_words(col_words, base_m + 2))

        # Month 4 of page (bottom-right)
        for (x_min, x_max) in subcols_right:
            col_words = [w for w in words if x_min <= w['x0'] < x_max and y_bot[0] <= w['top'] < y_bot[1]]
            all_entries.extend(extract_from_words(col_words, base_m + 3))

    # De-duplicate if needed
    unique = {}
    for entry in all_entries:
        unique[f"{entry['date']}_{entry['time']}"] = entry

    return list(unique.values())


def classify_tides(tides):
    """Classify tides into high and low using local extrema and median threshold."""
    tides.sort(key=lambda x: (x['date'], x['time']))

    if not tides:
        return tides

    heights = sorted(t['height'] for t in tides)
    median_h = heights[len(heights) // 2]

    for i in range(len(tides)):
        prev_h = tides[i - 1]['height'] if i > 0 else tides[i]['height']
        next_h = tides[i + 1]['height'] if i < len(tides) - 1 else tides[i]['height']
        curr = tides[i]['height']

        if curr > prev_h and curr > next_h:
            tides[i]['type'] = 'high'
        elif curr < prev_h and curr < next_h:
            tides[i]['type'] = 'low'
        elif curr > median_h:
            tides[i]['type'] = 'high'
        else:
            tides[i]['type'] = 'low'

    return tides


def validate_data(tides, loc_name):
    """Validate 365 days coverage and format correctness."""
    issues = []

    unique_days = sorted(set(t['date'] for t in tides))
    if len(unique_days) != 365:
        issues.append(f"Day count: {len(unique_days)}/365")

    day_counts = defaultdict(int)
    for t in tides:
        day_counts[t['date']] += 1
        # Validate time format
        if not re.match(r'^\d{2}:\d{2}$', t['time']):
            issues.append(f"Bad time: {t['time']}")

    suspicious = [d for d, c in day_counts.items() if c < 1 or c > 6]
    if suspicious:
        issues.append(f"Suspicious tide count on {len(suspicious)} days")

    return issues


def get_metadata(doc, page_no):
    """Extract official title and coordinate subtitle from page header."""
    p = doc[page_no]
    text = p.get_text()
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    raw_title = lines[0]
    # Clean title
    title = raw_title
    if "WESTERN AUSTRALIA" not in title and "BAY" not in title and "RIVER" not in title and "MARINA" not in title:
        title = f"{raw_title} – WESTERN AUSTRALIA"

    subtitle = ""
    for l in lines[1:6]:
        if "LAT" in l or "LONG" in l:
            subtitle = l
            break

    return title, subtitle


def main():
    if not os.path.exists(PDF_PATH):
        print(f"ERROR: {PDF_PATH} not found!")
        sys.exit(1)

    print(f"Opening {PDF_PATH}...")
    doc = fitz.open(PDF_PATH)
    print(f"Total pages: {len(doc)}")

    manifest = {}

    for idx, cfg in enumerate(LOCATIONS_CONFIG):
        slug = cfg["slug"]
        name = cfg["name"]
        print(f"\n[{idx + 1:02d}/40] Processing {name} ({slug})...")

        title, subtitle = get_metadata(doc, cfg["pages"][0])
        raw_tides = extract_location(doc, cfg)
        classified = classify_tides(raw_tides)
        issues = validate_data(classified, name)

        if issues:
            print(f"  ⚠️  Issues: {', '.join(issues)}")
        else:
            print(f"  ✓ Valid (365 days, {len(classified)} tides)")

        output_filename = f"tides_{slug}.json"
        with open(output_filename, "w") as f:
            json.dump({
                "location": name,
                "slug": slug,
                "year": YEAR,
                "title": title,
                "subtitle": subtitle,
                "source": "Government of Western Australia Department of Transport / Bureau of Meteorology",
                "extracted": datetime.now().isoformat(),
                "tides": classified
            }, f, indent=2)

        # Height stats for UI slider bounds
        heights = [t["height"] for t in classified]
        min_h = min(heights) if heights else 0.0
        max_h = max(heights) if heights else 1.5

        # Format bounds rounded for UI slider
        slider_min = max(0.0, round(min_h - 0.1, 1))
        slider_max = round(max_h + 0.2, 1)

        manifest[slug] = {
            "id": slug,
            "name": name,
            "file": output_filename,
            "title": title,
            "subtitle": subtitle,
            "minHeight": slider_min,
            "maxHeight": slider_max,
            "heightStep": 0.1,
            "tideCount": len(classified)
        }

    # Save manifest
    with open("locations.json", "w") as f:
        json.dump(manifest, f, indent=2)
    print("\n✓ Saved locations.json index")
    print("All 40 locations processed successfully!")


if __name__ == "__main__":
    main()
