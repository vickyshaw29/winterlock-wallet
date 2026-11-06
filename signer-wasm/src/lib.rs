use js_sys::{Error as JsError, JSON, Reflect};
use serde_json::Value;
use signer::api::{self, Fail, Keys, fail};
use wasm_bindgen::prelude::*;

fn call(req: JsValue, f: impl FnOnce(&Value) -> Result<Value, Fail>) -> Result<JsValue, JsValue> {
    let req = JSON::stringify(&req)
        .ok()
        .and_then(|s| serde_json::from_str(&String::from(s)).ok())
        .filter(Value::is_object)
        .ok_or_else(|| throw(fail("bad_args", "request must be an object")))?;
    JSON::parse(&f(&req).map_err(throw)?.to_string())
}

fn throw(f: Fail) -> JsValue {
    let error = JsError::new(&f.detail);
    let _ = Reflect::set(&error, &"code".into(), &f.code.into());
    error.into()
}

fn text<'a>(req: &'a Value, key: &str) -> Result<&'a str, Fail> {
    req[key]
        .as_str()
        .ok_or_else(|| fail("bad_args", format!("{key} must be a string")))
}

fn num<T: TryFrom<u64>>(req: &Value, key: &str) -> Result<T, Fail> {
    let n = req[key].as_u64().and_then(|n| T::try_from(n).ok());
    n.ok_or_else(|| {
        fail(
            "bad_args",
            format!("{key} must be a non-negative integer in range"),
        )
    })
}

fn keys(req: &Value) -> Result<Keys, Fail> {
    let chains = req["chains"]
        .as_array()
        .and_then(|c| c.iter().map(Value::as_u64).collect());
    Ok(Keys {
        master: api::seed(req["seed"].as_str().unwrap_or_default())?,
        generation: if req["generation"].is_null() {
            0
        } else {
            num(req, "generation")?
        },
        height: num(req, "height")?,
        chains: chains.ok_or_else(|| fail("bad_args", "chains must be an array of chain ids"))?,
    })
}

#[wasm_bindgen]
pub fn keygen(req: JsValue) -> Result<JsValue, JsValue> {
    call(req, |r| api::keygen(&keys(r)?))
}

#[wasm_bindgen]
pub fn pubkey(req: JsValue) -> Result<JsValue, JsValue> {
    call(req, |r| {
        api::pubkey(&keys(r)?, num(r, "chainId")?, num(r, "leaf")?)
    })
}

#[wasm_bindgen]
pub fn sign(req: JsValue) -> Result<JsValue, JsValue> {
    call(req, |r| match r.get("ticket") {
        Some(ticket) => api::sign_ticket(
            ticket,
            r["chainId"].as_u64(),
            num(r, "leaf")?,
            text(r, "msg")?,
        ),
        None => api::sign(
            &keys(r)?,
            num(r, "chainId")?,
            num(r, "leaf")?,
            text(r, "msg")?,
        ),
    })
}

#[wasm_bindgen]
pub fn verify(req: JsValue) -> Result<JsValue, JsValue> {
    call(req, |r| {
        api::verify(
            text(r, "treeSeed")?,
            text(r, "root")?,
            num(r, "height")?,
            num(r, "chainId")?,
            num(r, "leaf")?,
            text(r, "msg")?,
            text(r, "entry")?,
        )
    })
}

#[wasm_bindgen(js_name = exportLeaves)]
pub fn export_leaves(req: JsValue) -> Result<JsValue, JsValue> {
    call(req, |r| {
        let (from, to, hot_start) = (num(r, "from")?, num(r, "to")?, num(r, "hotStart")?);
        api::export(&keys(r)?, num(r, "chainId")?, from, to, hot_start)
    })
}
