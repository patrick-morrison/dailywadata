#!/usr/bin/env python3
"""
Single script to optmise docs/ folder → docs_new/
- Extracts and compresses GeoJSON data
- Uses shared assets folder (no duplication)
- Creates lightweight HTML files
"""

import os
import re
import json
import gzip
import shutil
from pathlib import Path

def optmise_docs():
    """Main optmisation function."""

    # Setup directories
    docs_new = Path('docs_new')
    maps_new = docs_new / 'maps'
    data_dir = maps_new / 'data'
    shared_assets = maps_new / 'assets'

    # Remove old docs_new if exists
    if docs_new.exists():
        shutil.rmtree(docs_new)

    maps_new.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(exist_ok=True)

    # Copy ONE _files directory as shared assets
    source_files = Path('docs/maps/mandurah_files')
    if source_files.exists():
        shutil.copytree(source_files, shared_assets)
        assets_size = sum(f.stat().st_size for f in shared_assets.rglob('*') if f.is_file())
        print(f"Copied shared assets ({assets_size/1024:.0f}KB)")
    else:
        print(f"Warning: {source_files} not found, skipping assets")

    # Find HTML files to process
    html_files = list(Path('docs/maps').glob('*_original.html'))
    if not html_files:
        html_files = list(Path('docs/maps').glob('*.html'))
        html_files = [f for f in html_files if not f.stem.endswith('_original')]

    print(f"Processing {len(html_files)} maps\n")

    total_original_size = 0
    total_new_size = 0
    total_data_size = 0

    for idx, html_file in enumerate(html_files, 1):
        base_stem = html_file.stem.replace('_original', '')
        print(f"[{idx}/{len(html_files)}] {base_stem}")

        # Read original HTML
        with open(html_file, 'r', encoding='utf-8') as f:
            content = f.read()

        original_size = len(content)
        total_original_size += original_size

        # Update asset paths to use shared folder
        content = re.sub(
            rf'{base_stem}_files/',
            'assets/',
            content
        )

        # Extract and compress JSON data
        pattern = r'<script type="application/json" data-for="([^"]+)">\s*(\{.+?\})\s*</script>'
        matches = re.findall(pattern, content, re.DOTALL)

        if matches:
            for data_for_id, json_data in enumerate(matches):
                try:
                    data_for_id, json_data = json_data  # unpack tuple
                    parsed_json = json.loads(json_data)

                    # Add Canvas renderer for better performance with many polygons
                    if 'x' in parsed_json and 'options' in parsed_json['x']:
                        parsed_json['x']['options']['preferCanvas'] = True

                    # Save compressed data
                    data_filename = f'{base_stem}_data.json.gz'
                    data_path = data_dir / data_filename

                    with gzip.open(data_path, 'wt', encoding='utf-8') as f:
                        json.dump(parsed_json, f, separators=(',', ':'))

                    compressed_size = os.path.getsize(data_path)
                    total_data_size += compressed_size

                    reduction = (1 - compressed_size / len(json_data)) * 100
                    print(f"  Data: {len(json_data)/1024:.0f}KB -> {compressed_size/1024:.0f}KB ({reduction:.1f}% reduction)")

                    # Create loader that prevents HTMLWidgets from rendering until data is loaded
                    # Use a placeholder type to prevent HTMLWidgets from processing it early
                    loader_script = f'''<style>
#map-loader {{
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: white;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 9999;
}}
#map-loader .spinner {{
    width: 50px;
    height: 50px;
    border: 4px solid #e0e0e0;
    border-top: 4px solid #2e7d32;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}}
#map-loader .text {{
    margin-top: 20px;
    font-family: Arial, sans-serif;
    font-size: 18px;
    color: #2e7d32;
    font-weight: 500;
}}
@keyframes spin {{
    0% {{ transform: rotate(0deg); }}
    100% {{ transform: rotate(360deg); }}
}}
</style>
<div id="map-loader">
    <div class="spinner"></div>
    <div class="text">Loading</div>
</div>
<script type="application/x-placeholder" data-for="{data_for_id}" id="json-{data_for_id}">
{{}}</script>
<script>
(function() {{
    // Prevent HTMLWidgets from auto-rendering
    var originalStaticRender = null;
    if (window.HTMLWidgets) {{
        originalStaticRender = window.HTMLWidgets.staticRender;
        window.HTMLWidgets.staticRender = function() {{}};
    }}

    function loadMapData() {{
        fetch('data/{data_filename}')
            .then(response => {{
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.arrayBuffer();
            }})
            .then(buffer => {{
                const ds = new DecompressionStream('gzip');
                return new Response(
                    new Blob([buffer]).stream().pipeThrough(ds)
                ).text();
            }})
            .then(text => {{
                const data = JSON.parse(text);
                const scriptTag = document.getElementById('json-{data_for_id}');
                if (scriptTag) {{
                    // Set the data
                    scriptTag.textContent = JSON.stringify(data);
                    // Change type to application/json so HTMLWidgets can find it
                    scriptTag.type = 'application/json';

                    // Restore and call the original render function
                    if (window.HTMLWidgets) {{
                        if (originalStaticRender) {{
                            window.HTMLWidgets.staticRender = originalStaticRender;
                        }}
                        try {{
                            window.HTMLWidgets.staticRender();
                        }} catch (e) {{
                            console.error('HTMLWidgets render error:', e);
                        }}
                    }}

                    // Hide loading spinner
                    const loader = document.getElementById('map-loader');
                    if (loader) loader.style.display = 'none';
                }}
            }})
            .catch(error => {{
                console.error('Error loading map data:', error);
                document.body.innerHTML = '<div style="padding: 40px; text-align: center; font-family: Arial;">' +
                    '<h2>Map Loading Error</h2>' +
                    '<p>Failed to load map data. Please check:</p>' +
                    '<ul style="list-style: none; padding: 0; text-align: left; display: inline-block;">' +
                    '<li>All files are uploaded to the server</li>' +
                    '<li>Browser supports DecompressionStream (Chrome 80+, Firefox 102+, Safari 16.4+)</li>' +
                    '<li>Server allows .gz file serving</li>' +
                    '</ul>' +
                    '<p style="color: #999; font-size: 12px; margin-top: 20px;">Error: ' + error.message + '</p>' +
                    '</div>';
            }});
    }}

    // Load when DOM is ready
    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', loadMapData);
    }} else {{
        loadMapData();
    }}
}})();
</script>'''

                    # Replace embedded JSON
                    original_pattern = f'<script type="application/json" data-for="{re.escape(data_for_id)}">\\s*{re.escape(json_data)}\\s*</script>'
                    content = re.sub(original_pattern, loader_script, content, count=1, flags=re.DOTALL)

                except (json.JSONDecodeError, ValueError) as e:
                    print(f"  Error processing JSON: {e}")

        # Save optimised HTML
        output_name = html_file.name.replace('_original.html', '.html')
        output_html = maps_new / output_name
        with open(output_html, 'w', encoding='utf-8') as f:
            f.write(content)

        new_size = len(content)
        total_new_size += new_size

    # Copy index.html if exists
    index_file = Path('docs/index.html')
    if index_file.exists():
        shutil.copy(index_file, docs_new / 'index.html')
        print(f"\nCopied index.html")

    # Calculate total size
    total_docs_size = sum(f.stat().st_size for f in docs_new.rglob('*') if f.is_file())

    # Print summary
    print("\n" + "-"*70)
    print("Optimisation complete")
    print("-"*70)
    print(f"Original size:  {total_original_size/1024/1024:>8.1f} MB (HTML only)")
    print(f"Optimised size: {total_docs_size/1024/1024:>8.1f} MB (complete)")
    print(f"Reduction:      {(1 - total_docs_size/total_original_size)*100:>8.1f}%")
    print(f"\nOutput: {docs_new.absolute()}")
    print("-"*70 + "\n")

if __name__ == '__main__':
    optmise_docs()
