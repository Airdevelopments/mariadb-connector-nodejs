//  SPDX-License-Identifier: LGPL-2.1-or-later
//  Copyright (c) 2015-2023 MariaDB Corporation Ab

'use strict';

const Command = require('../command');
const Errors = require('../../misc/errors');
const Capabilities = require('../../const/capabilities');
const Handshake = require('./auth/handshake');
const Crypto = require('crypto');
const utils = require('../../misc/utils');
const authenticationPlugins = {
  mysql_native_password: require('./auth/native-password-auth.js'),
  mysql_clear_password: require('./auth/clear-password-auth'),
  client_ed25519: require('./auth/ed25519-password-auth'),
  dialog: require('./auth/pam-password-auth'),
  sha256_password: require('./auth/sha256-password-auth'),
  caching_sha2_password: require('./auth/caching-sha2-password-auth')
};
const assert = require('node:assert/strict');

/**
 * Handle handshake.
 * see https://mariadb.com/kb/en/library/1-connecting-connecting/
 */
class Authentication extends Command {
  constructor(cmdParam, resolve, reject, _createSecureContext, getSocket) {
    super(cmdParam, resolve, reject);
    this._createSecureContext = _createSecureContext;
    this.getSocket = getSocket;
    this.plugin = new Handshake(this, getSocket, this.handshakeResult, reject);
  }

  onPacketReceive(packet, out, opts, info) {
    this.plugin.sequenceNo = this.sequenceNo;
    this.plugin.compressSequenceNo = this.compressSequenceNo;
    this.plugin.onPacketReceive(packet, out, opts, info);
  }

  /**
   * Fast-path handshake results :
   *  - if plugin was the one expected by server, server will send OK_Packet / ERR_Packet.
   *  - if not, server send an AuthSwitchRequest packet, indicating the specific PLUGIN to use with this user.
   *    dispatching to plugin handler then.
   *
   * @param packet    current packet
   * @param out       output buffer
   * @param opts      options
   * @param info      connection info
   * @returns {*}     return null if authentication succeed, depending on plugin conversation if not finished
   */
  handshakeResult(packet, out, opts, info) {
    const marker = packet.peek();
    switch (marker) {
      //*********************************************************************************************************
      //* AuthSwitchRequest packet
      //*********************************************************************************************************
      case 0xfe:
        this.dispatchAuthSwitchRequest(packet, out, opts, info);
        return;

      //*********************************************************************************************************
      //* OK_Packet - authentication succeeded
      //*********************************************************************************************************
      case 0x00:
        this.plugin.onPacketReceive = null;
        packet.skip(1); //skip header
        packet.skipLengthCodedNumber(); //skip affected rows
        packet.skipLengthCodedNumber(); //skip last insert id
        info.status = packet.readUInt16();

        if (info.requireValidCert && info.selfSignedCertificate) {
          // TLS was forced to trust, and certificate validation is required
          packet.skip(2); //skip warning count
          if (packet.remaining()) {
            const validationHash = packet.readBufferLengthEncoded();
            if (validationHash.length > 0) {
              if (!this.plugin.permitHash() || !this.cmdParam.opts.password || this.cmdParam.opts.password === '') {
                return this.throwNewError(
                  'Self signed certificates. Either set `ssl: { rejectUnauthorized: false }` (trust mode) or provide server certificate to client',
                  true,
                  info,
                  '08000',
                  Errors.ER_SELF_SIGNED_NO_PWD
                );
              }
              if (this.validateFingerPrint(validationHash, info)) {
                return this.successEnd();
              }
            }
          }
          return this.throwNewError('self-signed certificate', true, info, '08000', Errors.ER_SELF_SIGNED);
        }
        return this.successEnd();

      //*********************************************************************************************************
      //* ERR_Packet
      //*********************************************************************************************************
      case 0xff:
        this.plugin.onPacketReceive = null;
        const authErr = packet.readError(info, this.displaySql());
        authErr.fatal = true;
        return this.plugin.throwError(authErr, info);

      //*********************************************************************************************************
      //* unexpected
      //*********************************************************************************************************
      default:
        this.throwNewError(
          `Unexpected type of packet during handshake phase : ${marker}`,
          true,
          info,
          '42000',
          Errors.ER_AUTHENTICATION_BAD_PACKET
        );
    }
  }

  validateFingerPrint(validationHash, info) {
    if (validationHash.length == 0) return false;
    assert.equal(validationHash[0], 0x01); // SHA256 encryption

    const pwdHash = this.plugin.hash(this.cmdParam.opts);

    let hash = Crypto.createHash('sha256');
    let digest = hash.update(pwdHash).update(info.seed).update(Buffer.from(info.tlsFingerprint, 'hex')).digest();
    const hashHex = utils.toHexString(digest);
    const serverValidationHex = validationHash.toString('ascii', 1, validationHash.length).toLowerCase();
    return hashHex === serverValidationHex;
  }

  /**
   * Handle authentication switch request : dispatch to plugin handler.
   *
   * @param packet  packet
   * @param out     output writer
   * @param opts    options
   * @param info    connection information
   */
  dispatchAuthSwitchRequest(packet, out, opts, info) {
    let pluginName, pluginData;
    if (info.clientCapabilities & Capabilities.PLUGIN_AUTH) {
      packet.skip(1); //header
      if (packet.remaining()) {
        //AuthSwitchRequest packet.
        pluginName = packet.readStringNullEnded();
        pluginData = packet.readBufferRemaining();
      } else {
        //OldAuthSwitchRequest
        pluginName = 'mysql_old_password';
        pluginData = info.seed.slice(0, 8);
      }
    } else {
      pluginName = packet.readStringNullEnded('ascii');
      pluginData = packet.readBufferRemaining();
    }

    if (opts.restrictedAuth && !opts.restrictedAuth.includes(pluginName)) {
      this.throwNewError(
        `Unsupported authentication plugin ${pluginName}. Authorized plugin: ${opts.restrictedAuth.toString()}`,
        true,
        info,
        '42000',
        Errors.ER_NOT_SUPPORTED_AUTH_PLUGIN
      );
      return;
    }
    try {
      this.plugin.emit('end');
      this.plugin.onPacketReceive = null;
      this.plugin = Authentication.pluginHandler(
        pluginName,
        this.plugin.sequenceNo,
        this.plugin.compressSequenceNo,
        pluginData,
        info,
        opts,
        out,
        this.cmdParam,
        this.reject,
        this.handshakeResult.bind(this)
      );
      this.plugin.start(out, opts, info);
    } catch (err) {
      this.reject(err);
      return;
    }
  }

  static pluginHandler(
    pluginName,
    packSeq,
    compressPackSeq,
    pluginData,
    info,
    opts,
    out,
    cmdParam,
    authReject,
    multiAuthResolver
  ) {
    let pluginAuth = authenticationPlugins[pluginName];
    if (!pluginAuth) {
      throw Errors.createFatalError(
        `Client does not support authentication protocol '${pluginName}' requested by server.`,
        Errors.ER_AUTHENTICATION_PLUGIN_NOT_SUPPORTED,
        info,
        '08004'
      );
    }
    return new pluginAuth(packSeq, compressPackSeq, pluginData, cmdParam, authReject, multiAuthResolver);
  }
}

module.exports = Authentication;
