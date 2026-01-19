#!/usr/bin/env python3
"""
Convert whale sighting Excel files to consolidated CSV.
Parses coordinate formats and standardizes date/time.
"""

import pandas as pd
import re
from datetime import datetime

def parse_coordinate(coord_str):
    """
    Parse coordinate string in various formats:
    - "16˚ 14.123'S" or "16° 14.123'S" (degrees + decimal minutes)
    - "17 53.411'S" (no degree symbol)
    Returns decimal degrees (negative for S/W)
    """
    if pd.isna(coord_str):
        return None

    coord_str = str(coord_str).strip()

    # Pattern: degrees (with or without symbol), minutes (with decimal), direction
    # Handles: 16˚ 14.123'S, 16° 14.123'S, 17 53.411'S, 122˚ 58.349'E
    pattern = r"(\d+)[˚°\s]+(\d+\.?\d*)['\s]*([NSEW])"
    match = re.search(pattern, coord_str, re.IGNORECASE)

    if not match:
        return None

    degrees = float(match.group(1))
    minutes = float(match.group(2))
    direction = match.group(3).upper()

    decimal = degrees + minutes / 60.0

    # Make negative for South and West
    if direction in ['S', 'W']:
        decimal = -decimal

    return round(decimal, 6)

def parse_date(day_str, month_str, year):
    """Parse date from separate columns to ISO format."""
    try:
        # Remove ordinal suffixes (1st, 2nd, 3rd, 4th, etc.)
        day = int(re.sub(r'(st|nd|rd|th)', '', str(day_str)))

        # Parse month name
        month_map = {
            'january': 1, 'february': 2, 'march': 3, 'april': 4,
            'may': 5, 'june': 6, 'july': 7, 'august': 8,
            'september': 9, 'october': 10, 'november': 11, 'december': 12
        }
        month = month_map.get(str(month_str).lower().strip(), None)
        if not month:
            return None

        year = int(year)
        return f"{year}-{month:02d}-{day:02d}"
    except (ValueError, TypeError):
        return None

def parse_time(time_val):
    """Parse time from decimal hours (6.3 = 06:18) or time string."""
    try:
        if pd.isna(time_val):
            return "00:00"

        time_str = str(time_val)

        # Handle time ranges like "7:00 to 10:12" - take first time
        if 'to' in time_str.lower():
            time_str = time_str.split('to')[0].strip()

        # Handle HH:MM format
        if ':' in time_str:
            parts = time_str.split(':')
            return f"{int(parts[0]):02d}:{int(parts[1]):02d}"

        # Handle decimal hours (6.3 = 6 hours + 0.3*60 minutes = 6:18)
        hours = float(time_str)
        h = int(hours)
        m = int((hours - h) * 60)
        return f"{h:02d}:{m:02d}"
    except (ValueError, TypeError):
        return "00:00"

def process_file(filepath, year):
    """Process a single Excel file and return list of records."""
    print(f"Processing {filepath}...")

    # Read Excel file
    engine = 'xlrd' if filepath.endswith('.xls') else 'openpyxl'
    df = pd.read_excel(filepath, header=0, engine=engine)

    # Get header row to find column indices
    headers = list(df.iloc[0])

    # Find column indices by name
    def find_col(names):
        for name in names:
            for i, h in enumerate(headers):
                if h and name.lower() in str(h).lower():
                    return i
        return None

    lat_col = find_col(['latitude'])
    lng_col = find_col(['longitude'])
    day_col = find_col(['day'])
    month_col = find_col(['month'])
    year_col = find_col(['year'])
    time_col = find_col(['24hrs', 'time'])
    species_col = find_col(['species'])
    adults_col = find_col(['no. adult', 'adult whales'])
    calves_col = find_col(['no. calves', 'calves'])
    total_col = find_col(['total no. whales'])
    location_col = find_col(['location'])

    records = []
    skipped = 0

    # Process data rows (skip header row at index 0)
    for i in range(1, len(df)):
        row = df.iloc[i]

        # Parse coordinates
        lat = parse_coordinate(row.iloc[lat_col]) if lat_col is not None else None
        lng = parse_coordinate(row.iloc[lng_col]) if lng_col is not None else None

        # Skip rows without valid coordinates
        if lat is None or lng is None:
            skipped += 1
            continue

        # Parse date
        if day_col is not None and month_col is not None and year_col is not None:
            date = parse_date(row.iloc[day_col], row.iloc[month_col], row.iloc[year_col])
        else:
            date = None

        if not date:
            skipped += 1
            continue

        # Parse other fields
        time = parse_time(row.iloc[time_col]) if time_col is not None else "00:00"
        species = str(row.iloc[species_col]).strip() if species_col is not None and pd.notna(row.iloc[species_col]) else "Unknown"
        adults = int(row.iloc[adults_col]) if adults_col is not None and pd.notna(row.iloc[adults_col]) else 0
        calves = int(row.iloc[calves_col]) if calves_col is not None and pd.notna(row.iloc[calves_col]) else 0
        total = int(row.iloc[total_col]) if total_col is not None and pd.notna(row.iloc[total_col]) else adults + calves
        location = str(row.iloc[location_col]).strip() if location_col is not None and pd.notna(row.iloc[location_col]) else ""

        records.append({
            'date': date,
            'time': time,
            'lat': lat,
            'lng': lng,
            'species': species,
            'adults': adults,
            'calves': calves,
            'total': total if total > 0 else adults + calves,
            'location': location
        })

    print(f"  Processed: {len(records)} records, Skipped: {skipped} (no coordinates)")
    return records

def main():
    base_path = '/home/aren/Nextcloud/Clients/Internal/dailywadata/day20-whales'

    files = [
        f'{base_path}/2008 Trip 5 Raw Data.xlsx',
        f'{base_path}/2009 Raw Data.xlsx',
        f'{base_path}/2010 Raw Data.xlsx',
        f'{base_path}/2011 Trip Raw Data.xls'
    ]

    all_records = []

    for filepath in files:
        year = int(filepath.split('/')[-1][:4])
        records = process_file(filepath, year)
        all_records.extend(records)

    # Sort by date and time
    all_records.sort(key=lambda r: (r['date'], r['time']))

    # Write to CSV
    output_path = f'{base_path}/whales.csv'
    df_out = pd.DataFrame(all_records)
    df_out.to_csv(output_path, index=False)

    print(f"\nTotal records: {len(all_records)}")
    print(f"Output written to: {output_path}")

    # Print summary by year
    print("\nRecords by year:")
    for year in sorted(set(r['date'][:4] for r in all_records)):
        count = sum(1 for r in all_records if r['date'].startswith(year))
        print(f"  {year}: {count}")

if __name__ == '__main__':
    main()
