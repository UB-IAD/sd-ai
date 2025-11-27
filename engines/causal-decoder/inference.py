#!/usr/bin/env python

from transformers import AutoTokenizer, AutoModelForCausalLM
import torch
import sys
import re
import json

def parse_relationships(text: str):
    rels = []
    for part in re.split(r"[,\n;]+", text):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"(.+?)->\s*([+-])\s*(.+)", part)
        if not m:
            continue
        frm, pol, to = m.group(1).strip(), m.group(2), m.group(3).strip()
        rels.append({"from": frm, "to": to, "polarity": pol})
    return rels

def generate_targets(tokenizer, model, paragraph: str,
                     strategy: str = "greedy",
                     max_new_tokens: int = 128,
                     num_beams: int = 4,
                     top_p: float = 0.9,
                     temperature: float = 0.7,
                     repetition_penalty: float = 1.05,
                     clean_regex: bool = True):
    
    PROMPT_PREFIX = "### Paragraph:\n"
    TARGET_PREFIX = "\n\n### Targets:\n"
    prompt = f"{PROMPT_PREFIX}{paragraph}{TARGET_PREFIX}"
    enc = tokenizer(prompt, return_tensors="pt").to(model.device)

    gen_kwargs = dict(
        max_new_tokens=max_new_tokens,
        eos_token_id=tokenizer.eos_token_id,
        pad_token_id=tokenizer.pad_token_id,
        repetition_penalty=repetition_penalty,
    )
    if strategy == "greedy":
        gen_kwargs.update(dict(do_sample=False))
    elif strategy == "beam":
        gen_kwargs.update(dict(do_sample=False, num_beams=num_beams))
    elif strategy == "sample":
        gen_kwargs.update(dict(do_sample=True, top_p=top_p, temperature=temperature))
    else:
        raise ValueError("strategy must be 'greedy' | 'beam' | 'sample'")

    with torch.no_grad():
        out = model.generate(**enc, **gen_kwargs)

    new_tokens = out[0, enc["input_ids"].shape[1]:]
    raw = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()

    if not clean_regex:
        return raw, raw

    pairs = re.findall(r'[^,]+->[+-]\s*[^,]+', raw)
    cleaned = ", ".join(p.strip() for p in pairs) if pairs else raw
    return raw, cleaned

if __name__=="__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No prompt given"}))
        sys.exit(0)
        
    else:
        MODEL = "dorito96/qwen2.5-1.5b_causal"

        tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            MODEL,
            dtype=(torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported()
                        else (torch.float16 if torch.cuda.is_available() else torch.float32)),
            device_map=("auto" if torch.cuda.is_available() else "cpu"),
            trust_remote_code=True,
        )
        model.eval()

        paragraph = sys.argv[1]
        raw, _ = generate_targets(tok, model, paragraph, max_new_tokens=512, strategy="beam", temperature=1, num_beams= 2)
        relationships = parse_relationships(raw)

        out = {"success": True, "model": {"relationships": raw}}
        sys.stdout.write(json.dumps(out))
