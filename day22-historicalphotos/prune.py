import argparse
import numpy as np
from plyfile import PlyData, PlyElement

def prune_ply(input_path, output_path, target_count=750000, min_opacity=0.1):
    print(f"Loading {input_path}...")
    plydata = PlyData.read(input_path)
    
    vertex_element = plydata['vertex']
    count = vertex_element.count
    print(f"  Count: {count}")
    
    # 1. Filter by Opacity
    opacities = 1 / (1 + np.exp(-vertex_element['opacity'])) # Opacity is usually logit in PLY from ml-sharp/gaussian-splatting
    # Actually check if it's raw opacity or logit. 
    # Standard 3DGS .ply 'opacity' property is passed through sigmoid. 
    # But usually stored as raw float before sigmoid in many implementations? 
    # Let's check the range. output_gaussians logs show valid floats.
    # ml-sharp save_ply (seen in predict.py) stores: opacity_logits = _inverse_sigmoid(gaussians.opacities)
    # So the PLY contains LOGITS.
    # sigmoid(x) > 0.1  =>  x > logit(0.1) = log(0.1/0.9) = -2.197
    
    threshold_logit = np.log(min_opacity / (1.0 - min_opacity))
    
    mask = vertex_element['opacity'] > threshold_logit
    filtered_indices = np.where(mask)[0]
    print(f"  After opacity > {min_opacity} (logit > {threshold_logit:.2f}): {len(filtered_indices)}")
    
    # 2. Random Subsample if still over target
    if len(filtered_indices) > target_count:
        print(f"  Still over target {target_count}. Random thinning...")
        # Randomly choose target_count indices from the filtered set
        keep_indices = np.random.choice(filtered_indices, target_count, replace=False)
        keep_indices.sort() # Keep original order mostly
    else:
        keep_indices = filtered_indices

    print(f"  Final count: {len(keep_indices)}")
    
    # Create new PlyElement with kept vertices
    new_data = vertex_element.data[keep_indices]
    new_vertex_element = PlyElement.describe(new_data, 'vertex')
    
    # Copy other elements (camera params etc)
    new_elements = [new_vertex_element]
    for elem in plydata.elements:
        if elem.name != 'vertex':
            new_elements.append(elem)
            
    new_plydata = PlyData(new_elements, text=plydata.text)
    new_plydata.write(output_path)
    print(f"  Saved to {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Input PLY file")
    parser.add_argument("output", help="Output PLY file")
    parser.add_argument("--target", type=int, default=750000, help="Target splat count")
    parser.add_argument("--opacity", type=float, default=0.1, help="Min opacity threshold")
    
    args = parser.parse_args()
    prune_ply(args.input, args.output, args.target, args.opacity)
