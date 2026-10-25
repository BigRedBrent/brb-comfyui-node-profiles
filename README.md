# Node Profiles

A ComfyUI node for profile presets across your whole workflow. It saves the settings of the nodes connected to it, like your prompts and selected images, as named profiles. Pick a profile to put everything back, so one workflow can switch between many prompt and image setups.

## How it works

Wire any output of a node into one of the slots, such as a Load Image's image output or a prompt node's output. A new empty slot appears each time you connect the last one. To remove a slot, right-click it and choose Remove Slot. Each slot follows its wire back to the one node the value comes from: through reroutes, out of a subgraph to whatever is connected to it outside, and into a subgraph from its output to the node inside that produces it. A subgraph's own settings are never saved. If a node inside a subgraph has a setting shown as a field on the subgraph's outside, that setting is saved and restored through the field. A Node Profiles node placed inside a subgraph and wired from one of the subgraph's inputs saves just that input's field; to save a whole node, wire from that node's output instead.

Profiles belong to the slots, not to the nodes connected to them. If you move a wire to a different slot, profiles saved before the move still restore that slot's settings into whatever is connected to it now. Keep each slot connected to the same kind of node, or re-save your profiles after rewiring.

Saving stores every setting of each connected node by name, and whether it's active, bypassed or muted. Loading puts them back. Images are saved by file name, so the files need to stay in your input folder.

Profiles are kept inside the node, so they're saved with the workflow. Save the workflow after changing profiles. Deleting the node deletes its profiles, and copying the node copies them.

## Controls

- **profile:** the list of saved profiles. Picking a different one loads it. If the current profile has changes that haven't been saved, it asks first.
- **Save:** saves the current settings over the selected profile, after asking. It turns green when the loaded profile has changes that could be saved.
- **Discard:** discards your changes by putting the selected profile's saved settings back. It's grayed out while there are no changes to discard. If a slot has saved settings but nothing connected, or a saved value no longer exists, the rest is still restored and a message lists what was skipped. Each saved setting goes back to the setting with the same name. Saved text that has no matching name, such as when a node was swapped for a different kind, goes into the remaining text fields in order, first to first. A message only appears for saved settings that had nowhere to go.
- **Save As:** saves the current settings under a new name. Using an existing name asks before overwriting.
- **Rename:** renames the selected profile. A name that's already in use is refused.
- **Delete:** deletes the selected profile, after asking.
- **restore title, restore color, restore size, restore collapsed:** these are always saved, but only put back when turned on. All are off by default.
- **Import:** replaces all the node's profiles with the ones from a .json file, after asking.
- **Export:** saves all the node's profiles to a .json file.
