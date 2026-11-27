package com.tradesight.mobile;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureCredentials")
public final class SecureCredentialsPlugin extends Plugin {
    private static final String PREFS = "tradesight_secure_credentials";
    private static final String KEY_SIFTING = "siftingio_api_key";
    private static final String KEY_ALIAS = "com.tradesight.mobile.siftingio.aes";

    @PluginMethod
    public void saveSiftingIoKey(PluginCall call) {
        String apiKey = call.getString("apiKey");
        if (apiKey == null || apiKey.trim().isEmpty()) {
            call.reject("A non-empty SiftingIO API key is required.");
            return;
        }
        try {
            byte[] encrypted = encrypt(apiKey.trim().getBytes(StandardCharsets.UTF_8));
            String encoded = Base64.encodeToString(encrypted, Base64.NO_WRAP);
            boolean stored = getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .edit().putString(KEY_SIFTING, encoded).commit();
            if (!stored) throw new IllegalStateException("Encrypted credential could not be committed to disk.");
            JSObject result = new JSObject();
            result.put("saved", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not securely save the SiftingIO key (" + error.getClass().getSimpleName() + ").");
        }
    }

    @PluginMethod
    public void getSiftingIoKey(PluginCall call) {
        try {
            SharedPreferences preferences = getContext().getSharedPreferences(
                PREFS, android.content.Context.MODE_PRIVATE
            );
            String encoded = preferences.getString(KEY_SIFTING, null);
            JSObject result = new JSObject();
            if (encoded == null || encoded.isEmpty()) {
                result.put("apiKey", (String) null);
            } else {
                byte[] plaintext = decrypt(Base64.decode(encoded, Base64.NO_WRAP));
                result.put("apiKey", new String(plaintext, StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read the saved SiftingIO key (" + error.getClass().getSimpleName() + ").");
        }
    }

    @PluginMethod
    public void clearSiftingIoKey(PluginCall call) {
        boolean cleared = getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .edit().remove(KEY_SIFTING).commit();
        if (!cleared) {
            call.reject("The saved SiftingIO key could not be removed from device storage.");
            return;
        }
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
    }

    private byte[] encrypt(byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext);
        byte[] output = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, output, 0, iv.length);
        System.arraycopy(ciphertext, 0, output, iv.length, ciphertext.length);
        return output;
    }

    private byte[] decrypt(byte[] encrypted) throws Exception {
        if (encrypted.length <= 12) throw new IllegalArgumentException("Saved credential is invalid.");
        byte[] iv = new byte[12];
        byte[] ciphertext = new byte[encrypted.length - iv.length];
        System.arraycopy(encrypted, 0, iv, 0, iv.length);
        System.arraycopy(encrypted, iv.length, ciphertext, 0, ciphertext.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return cipher.doFinal(ciphertext);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
        );
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
