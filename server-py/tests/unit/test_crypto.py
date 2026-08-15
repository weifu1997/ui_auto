from autoflow.crypto import decrypt, encrypt, key_material


def test_decrypts_node_aes_gcm_fixture():
    fixture = {
        "iv": "AQEBAQEBAQEBAQEB",
        "tag": "zdT1JTvQ3sTrTfe2QNXyDA==",
        "ciphertext": "fR56IohfvGmFLWei",
    }
    assert decrypt(fixture) == "secret-value"


def test_encrypt_roundtrip_uses_development_secret():
    encrypted = encrypt("secret-value")
    assert decrypt(encrypted) == "secret-value"


def test_encrypt_roundtrip_uses_custom_secret():
    encrypted = encrypt("custom-value", secret="custom-platform-secret")
    assert decrypt(encrypted, secret="custom-platform-secret") == "custom-value"


def test_key_material_is_sha256_of_secret():
    assert key_material("abc") == key_material("abc")
    assert key_material("abc") != key_material("abd")
