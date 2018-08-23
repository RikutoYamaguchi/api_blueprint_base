const fse = require('fs-extra');
const path = require('path');
const drakov = require('drakov');
const nodeOpenssl = require('node-openssl-cert');
const openssl = new nodeOpenssl();
const exec = require('child_process').exec;

// 全体設定
const config = {
  // drakovを走らせるか
  drakovRun: true,
  // このフォルダ
  apiFilesRoot: './src',
  // エンコード
  fileEncoding: 'utf8',
  // エントリーファイル (このファイルでだけ`<!-- include('./file/path') -->`が使える)
  entryFile: './index.apib',
  // drakov用のテンポラリファイル
  tempFile: './drakov.apib',
  // apibファイルをwatchするか (entryFileはいまのところwatch対象外)
  watch: true,
  // ssl認証ファイルを一式生成するか (opensslコマンドが使用できる環境のみ)
  generateSsl: false,
  // sslを有効とするか
  enableSsl: false,
  // ssl認証ファイル関連
  ssl: {
    dir: './ssl',
    rsa: './ssl/server.key',
    csr: './ssl/server.csr',
    cst: './ssl/server.cst',
  }
}

/**
 * drakovの設定
 * https://www.npmjs.com/package/drakov
 */
const drakovConfig = {
  sourceFiles: path.resolve(config.apiFilesRoot, config.tempFile),
  serverPort: 8081,
  watch: true,
  autoOptions: true,
  stealthmode: false,
}
let drakovStarted = false;

const rsaKeyOptions = {}

const csrOptions = {
  hash: 'sha512',
  subject: {
    countryName: 'US',
    stateOrProvinceName: 'Louisiana',
    localityName: 'Slidell',
    postalCode: '70458',
    streetAddress: '1001 Gause Blvd.',
    organizationName: 'SMH',
    organizationalUnitName: 'IT',
    commonName: [
      'certificatetools.com',
      'www.certificatetools.com'
    ],
    emailAddress: 'test@test.com'
  },
  extensions: {
    basicConstraints: {
      critical: true,
      CA: true,
      pathlen: 1
    },
    keyUsage: {
      //critical: false,
      usages: [
        'digitalSignature',
        'keyEncipherment'
      ]
    },
    extendedKeyUsage: {
      critical: true,
      usages: [
        'serverAuth',
        'clientAuth'
      ]
    },
    SANs: {
      DNS: [
        'certificatetools.com',
        'www.certificatetools.com'
      ]
    }
  }
}

const fileContextStore = {};

if (config.enableSsl) {

  // set drakov ssl configs
  drakovConfig.sslKeyFile = path.resolve(config.ssl.rsa)
  drakovConfig.sslCrtFile = path.resolve(config.ssl.cst)

  if (config.generateSsl) {
    console.log('[START] Generate ssl certificates')
    openssl.generateRSAPrivateKey(rsaKeyOptions, (err, key, cmd) => {
      if (err) throw err;
      // console.log(cmd);
      fse.outputFileSync(path.resolve(config.ssl.rsa), key)
      openssl.generateCSR(csrOptions, key, 'test', (err, csr, cmd) => {
        if (err) throw err;
        // console.log(cmd.command);
        fse.outputFileSync(path.resolve(config.ssl.csr), csr)
        exec(`openssl x509 -in ${path.resolve(config.ssl.csr)} -out ${path.resolve(config.ssl.cst)} -req -signkey ${path.resolve(config.ssl.rsa)} -days 3650`, (err, stdout, stderr) => {
          if (err) throw err;
          console.log('[FINISH] Generate ssl certificates')
          startLoadFiles();
        })
      });
    });
  } else {
    startLoadFiles();
  }
} else {
  startLoadFiles();
}

function startLoadFiles() {
  console.log('[START] Load api blueprint files')
  fse.readFile(path.resolve(config.apiFilesRoot, config.entryFile), config.fileEncoding, (err, data) => {
    if (err) throw err;
    fileContextStore.entry = { context: data };

    const includeFilesData = [];
    const reg = new RegExp(/<!--\sinclude\((.*)\)\s-->/, 'g');
    let matched;
    while((matched = reg.exec(data)) !== null) {
      includeFilesData.push(matched);
      if (!reg.global) break;
    }

    includeFilesData.forEach(includeFileData => {
      const includeFileReplacement = includeFileData[0];
      const includeFilePath = path.resolve(config.apiFilesRoot, includeFileData[1]);
      const fileData = fse.readFileSync(includeFilePath, config.fileEncoding)
      fileContextStore[includeFilePath] = {
        replacement: includeFileReplacement,
        context: fileData
      }

      // watch
      if (config.watch) {
        fse.watch(includeFilePath, {}, e => {
          const fileData = fse.readFileSync(includeFilePath, config.fileEncoding)
          fileContextStore[includeFilePath] = {
            replacement: includeFileReplacement,
            context: fileData
          }
          generateTempFile();
        })
      }
    })

    console.log('[FINISH] Load api blueprint files');
    // drakov用のファイルを書き込み
    generateTempFile();

    if (config.drakovRun) {
      drakov.run(drakovConfig, () => {
        drakovStarted = true;
        console.log('Started drakov.')
      })
    }

  })
}

function drakovReload() {
  drakov.stop();
  drakov.run(drakovConfig, () => {
    console.log('Started drakov.')
    drakovStarted = true;
  })
}

/**
 * 一時ファイル生成
 */
function generateTempFile() {
  console.log('[START] Generate api blueprint temp file');
  let replacedApib = fileContextStore.entry.context;
  Object.keys(fileContextStore).forEach(key => {
    if (key === 'entry') return;
    replacedApib = replacedApib.replace(fileContextStore[key].replacement, fileContextStore[key].context);
  })
  fse.outputFileSync(path.resolve(config.apiFilesRoot, config.tempFile), replacedApib)
  console.log('[FINISH] Generate api blueprint temp file');
  if (drakovStarted) {
    drakovReload();
  }
}

function removeTempFile() {
  fse.unlinkSync(path.resolve(config.apiFilesRoot, config.tempFile));
  console.log('Removed api blueprint temp file');
}

function removeSslFiles() {
  fse.removeSync(path.resolve(config.apiFilesRoot, config.ssl.dir));
  console.log('Removed ssl certificates');
}

process.on('SIGINT', () => {
  removeTempFile();
  // removeSslFiles();
  process.exit();
});
