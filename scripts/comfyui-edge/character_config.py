# Box-side PER-CHARACTER CONFIGURATION for the LoRA Studio box scripts (ADR-071).
#
# Every box script used to carry the first character the studio ever trained as literal constants:
# its trigger word, its identity sentence, its anatomy-specific structural guard, dataset globs
# built from its trigger word, and a single shared dataset folder per box. A second character
# therefore could not be trained without editing the scripts, and it would have overwritten the
# first one's pool, curated set and scorecards on the way.
#
# This module is the single place a character's identity is resolved from. The controller owns the
# authoritative values in `oshal_lora_characters` (subject, trigger_word, hero_image, ident_prompt,
# negative_prompt, identity_structure, identity_violation, base_model, box_root); the store
# dispatch passes them on the command line; everything else here is DERIVED FROM THE SUBJECT, never
# from a character literal. A box directory is per character, so two characters cannot collide.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                    | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Resolve a character's trigger, hero, identity
#     sentence, negative prompt, structural guard prompts, base model and per-character box
#     directories from arguments the controller supplies, so no box script holds a character
#     constant and two characters never share a dataset, curated set or scorecard directory.
import os
import re

HOME = os.path.expanduser("~")

#: Appended to every positive prompt. Character-neutral on purpose: it describes RENDER quality.
DEFAULT_QUALITY = ", highly detailed, sharp focus, intricate, clean render, best quality"

#: Character-neutral negative prompt. Anything about a specific anatomy (how many eyes, how many
#: limbs) belongs to the character row's `negative_prompt`, never to a shared default - a default
#: that says "two eyes" is a defect for every character that has two.
DEFAULT_NEGATIVE = "blurry, low quality, deformed, text, watermark, multiple characters, jpeg artifacts, lowres"

#: The SD1.5 checkpoint the studio trains against unless the character row names another.
DEFAULT_BASE_MODEL = "v1-5-pruned-emaonly-fp16.safetensors"

#: A subject becomes a directory name and a file stem, so it is restricted to a safe slug.
SUBJECT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class CharacterConfig(object):
    """
    @description One character's resolved identity plus the box directories that belong to it
      alone. Constructed by character_config() from parsed arguments; never from a literal.
    """

    def __init__(self, subject, trigger, hero, ident, negative, base_model,
                 identity_structure, identity_violation, root, quality=DEFAULT_QUALITY):
        self.subject = subject
        self.trigger = trigger
        self.hero = hero
        self.ident = ident
        self.negative = negative
        self.base_model = base_model
        self.identity_structure = identity_structure
        self.identity_violation = identity_violation
        self.root = root
        self.quality = quality

    @property
    def pool_dir(self):
        """Raw candidate image+caption pool for THIS character."""
        return os.path.join(self.root, "img")

    @property
    def curated_dir(self):
        """Judged training set for THIS character (what train-lora.py consumes)."""
        return os.path.join(self.root, "curated")

    @property
    def curated_zip(self):
        """Packaged training set for THIS character."""
        return os.path.join(self.root, "curated.zip")

    @property
    def validate_dir(self):
        """Scorecards and galleries for THIS character (v1.json never collides with another's)."""
        return os.path.join(self.root, "validate")

    @property
    def asset_prefix(self):
        """File stem for every image/caption pair this character owns."""
        return self.subject

    def hero_image_path(self, *search_dirs):
        """
        @description Resolve the locked hero to a real path. An absolute or already-existing value
          is used as given (the operator may point at a file anywhere); otherwise it is a filename
          looked up in the supplied directories, ComfyUI's input directory first.
        @param search_dirs - Directories to look in, in order.
        @returns An absolute path, or None when this character has no hero on the box yet.
        """
        if os.path.isabs(self.hero) or os.path.exists(self.hero):
            return self.hero if os.path.exists(self.hero) else None
        for base in search_dirs:
            candidate = os.path.join(base, self.hero)
            if os.path.exists(candidate):
                return candidate
        return None

    def pool_glob(self, marker=""):
        """
        @description Glob for this character's pool files, so one character's discovery can never
          pick up another's images out of a shared folder.
        @param marker - Optional batch marker ('h' for hero-derived HQ, 't' for targeted).
        @returns A glob pattern rooted on this character's own prefix.
        """
        return "%s_%s*.png" % (self.asset_prefix, marker)

    def pool_stem(self, marker, index):
        """
        @description The file stem for one generated pair.
        @param marker - Batch marker ('h', 't', ...).
        @param index - Sequence number within the batch.
        @returns '<subject>_<marker><index:04d>'.
        """
        return "%s_%s%04d" % (self.asset_prefix, marker, index)

    def prompt(self, description):
        """
        @description Build a positive prompt: the trigger word, the character's own identity
          sentence when it has one, the scene, then render quality.
        @param description - The scene (action, camera, expression, lighting).
        @returns The prompt string.
        """
        parts = [self.trigger]
        if self.ident:
            parts.append(self.ident)
        parts.append(description)
        return ", ".join(p for p in parts if p) + self.quality

    def caption(self, description):
        """
        @description Build a training caption: the trigger word plus the scene. The identity
          sentence is deliberately NOT captioned - the trigger is what the LoRA must learn.
        @param description - The scene.
        @returns The caption string.
        """
        return "%s, %s" % (self.trigger, description)

    def structural_prompts(self):
        """
        @description The contrastive structural guard for this character, if it declares one (for
          a one-eyed character: its own eye count against the violation of it). One without a pair
          is not guarded
          structurally rather than being guarded as some other character.
        @returns {'identity_structure', 'identity_violation'} or None.
        """
        if self.identity_structure and self.identity_violation:
            return {"identity_structure": self.identity_structure,
                    "identity_violation": self.identity_violation}
        return None


def add_character_arguments(parser, required=True):
    """
    @description Register the per-character arguments every box script accepts. The controller's
      lora dispatch fills them from `oshal_lora_characters`; omitted values derive from --character.
    @param parser - The argparse parser to extend.
    @param required - False for a manual tool whose paths are all given explicitly.
    @returns Nothing.
    """
    parser.add_argument("--character", required=required, default="", help="character subject slug (owns its box directory)")
    parser.add_argument("--trigger", default="", help="LoRA trigger word (default: the subject)")
    parser.add_argument("--hero", default="", help="locked hero image: a filename in ComfyUI's input, or a path")
    parser.add_argument("--ident", default="", help="canonical look sentence for generation prompts")
    parser.add_argument("--negative", default="", help="character-specific negative prompt")
    parser.add_argument("--identity-structure", default="", help="contrastive prompt the character SHOULD match")
    parser.add_argument("--identity-violation", default="", help="contrastive prompt that means the identity broke")
    parser.add_argument("--base-model", default="", help="checkpoint to generate/validate against")
    parser.add_argument("--box-root", default="", help="this character's box directory (default: ~/lora-characters/<subject>)")


def default_root(subject):
    """
    @description This character's own box directory. Per character by construction, which is what
      stops a second character overwriting the first one's pool, curated set and scorecards.
    @param subject - The validated subject slug.
    @returns An absolute path.
    """
    return os.path.join(HOME, "lora-characters", subject)


def character_config(args):
    """
    @description Resolve a CharacterConfig from parsed arguments. Anything the controller did not
      supply derives from the subject - never from a previously trained character.
    @param args - argparse namespace carrying add_character_arguments()'s options.
    @returns The resolved CharacterConfig.
    @raises SystemExit - when the subject is not a safe slug (it becomes a path and a file stem).
    """
    subject = str(getattr(args, "character", "") or "").strip()
    if not SUBJECT_PATTERN.match(subject):
        raise SystemExit("refusing character %r: a subject must match %s" % (subject, SUBJECT_PATTERN.pattern))
    return CharacterConfig(
        subject=subject,
        trigger=(getattr(args, "trigger", "") or "").strip() or subject,
        hero=(getattr(args, "hero", "") or "").strip() or ("hero_%s.png" % subject),
        ident=(getattr(args, "ident", "") or "").strip(),
        negative=(getattr(args, "negative", "") or "").strip() or DEFAULT_NEGATIVE,
        base_model=(getattr(args, "base_model", "") or "").strip() or DEFAULT_BASE_MODEL,
        identity_structure=(getattr(args, "identity_structure", "") or "").strip(),
        identity_violation=(getattr(args, "identity_violation", "") or "").strip(),
        root=(getattr(args, "box_root", "") or "").strip() or default_root(subject),
    )


def forwardable_arguments(config):
    """
    @description The character arguments as a flat argv list, so a script that shells out to a
      sibling script (overnight-loop.py) carries the SAME identity into every nested step instead
      of letting the nested script fall back to its own defaults.
    @param config - A resolved CharacterConfig.
    @returns A list of command-line tokens.
    """
    argv = ["--character", config.subject, "--trigger", config.trigger, "--hero", config.hero,
            "--negative", config.negative, "--base-model", config.base_model,
            "--box-root", config.root]
    if config.ident:
        argv += ["--ident", config.ident]
    if config.identity_structure:
        argv += ["--identity-structure", config.identity_structure]
    if config.identity_violation:
        argv += ["--identity-violation", config.identity_violation]
    return argv
