# Node Profiles works entirely in the ComfyUI page (see node_profiles.js). It never runs as part of a job,
# so there's nothing for the server to do here.

WEB_DIRECTORY = "."

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
