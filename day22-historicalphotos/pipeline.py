import os
import argparse
import subprocess
import shutil
from pathlib import Path
from prune import prune_ply

def run_pipeline(input_path, output_dir, target_count=750000, opacity=0.1):
    input_path = Path(input_path).resolve()
    output_dir = Path(output_dir).resolve()
    temp_dir = output_dir / "temp"
    
    # Ensure directories exist
    output_dir.mkdir(parents=True, exist_ok=True)
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"\n==================================================")
    print(f"Processing: {input_path.name}")
    print(f"==================================================")

    # ---------------------------------------------------------
    # Step 1: Generate High-Fidelity Splat (using ml-sharp)
    # ---------------------------------------------------------
    print(f"\n[1/3] Running SHARP prediction...")
    # sharp outputs file based on input stem.
    # We run it into temp_dir.
    cmd = [
        "sharp", "predict",
        "-i", str(input_path),
        "-o", str(temp_dir),
        # "--resolution", "1536", # Removed invalid flag
        "--device", "mps" # Explicitly use MPS (Mac) or cuda/cpu
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError:
        print(f"Error: SHARP generation failed for {input_path}")
        return

    # Locate the generated PLY (sharp names it [stem].ply)
    raw_ply = temp_dir / (input_path.stem + ".ply")
    if not raw_ply.exists():
        print(f"Error: Expected output {raw_ply} not found.")
        return

    # ---------------------------------------------------------
    # Step 2: Intelligent Thinning (Custom Pruning)
    # ---------------------------------------------------------
    print(f"\n[2/3] Thinning to {target_count} splats (Opacity > {opacity})...")
    thinned_ply = temp_dir / (input_path.stem + "_thinned.ply")
    
    try:
        prune_ply(str(raw_ply), str(thinned_ply), target_count=target_count, min_opacity=opacity)
    except Exception as e:
        print(f"Error during thinning: {e}")
        return

    # ---------------------------------------------------------
    # Step 3: Optimization & Compression (Splat-Transform -> SOG)
    # ---------------------------------------------------------
    # We strip Spherical Harmonics (SH) and compress to SOG for web delivery
    print(f"\n[3/3] Optimizing (Stripping Harmonics & SOG Compression)...")
    final_sog = output_dir / (input_path.stem + ".sog")
    
    cmd = [
        "splat-transform",
        str(thinned_ply),
        "--filter-harmonics", "0", # Remove view-dependent data (diffuse only)
        "-w", # Overwrite if exists
        str(final_sog)
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError:
        print(f"Error: Splat-transform failed.")
        return

    # ---------------------------------------------------------
    # Cleanup
    # ---------------------------------------------------------
    print(f"\nSuccess! Optimized file saved to:\n  -> {final_sog}")
    # Optional: Delete temp files
    if raw_ply.exists(): os.remove(raw_ply)
    if thinned_ply.exists(): os.remove(thinned_ply)
    
    # Try to remove temp dir if empty
    try:
        temp_dir.rmdir()
    except OSError:
        pass # Directory not empty or other error

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SHARP -> Quest 3 Optimized Pipeline")
    parser.add_argument("input", help="Path to single image or directory of images")
    parser.add_argument("output", help="Directory to save final optimized PLYs")
    parser.add_argument("--count", type=int, default=750000, help="Target splat count (default: 750k)")
    
    args = parser.parse_args()
    
    inp = Path(args.input)
    
    if inp.is_file():
        run_pipeline(inp, args.output, target_count=args.count)
        
    elif inp.is_dir():
        # Find all images
        extensions = {'.jpg', '.jpeg', '.png', '.webp'}
        images = [f for f in inp.rglob("*") if f.suffix.lower() in extensions]
        
        if not images:
            print(f"No images found in {inp}")
        else:
            print(f"Found {len(images)} images to process.")
            for img in images:
                run_pipeline(img, args.output, target_count=args.count)
                
    else:
        print(f"Input {inp} does not exist.")
