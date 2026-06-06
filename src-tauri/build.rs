fn main() {
    // The Claude bridge embeds these resources via include_str!; make rebuilds
    // pick up edits to them explicitly.
    println!("cargo:rerun-if-changed=resources/remotion-mcp-config.json");
    println!("cargo:rerun-if-changed=resources/remotion-skills.txt");
    println!("cargo:rerun-if-changed=resources/remotion-image-skills.txt");
    tauri_build::build()
}
