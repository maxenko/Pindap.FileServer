#!/usr/bin/env node
/*
 * Pindap file server, based on:
 * jQuery File Upload Plugin Node.js Example 2.1.1
 * https://github.com/blueimp/jQuery-File-Upload
 *
 * Copyright 2012, Sebastian Tschan
 * https://blueimp.net
 *
 * Licensed under the MIT license:
 * http://www.opensource.org/licenses/MIT
 */

/* jshint nomen:false */
/* global require, __dirname, unescape, console */

(function (port) {
    'use strict';
    var path = require('path'),
        fs = require('fs'),
    // Since Node 0.8, .existsSync() moved from path to fs:
        _existsSync = fs.existsSync || path.existsSync,
        formidable = require('formidable'),
        url = require('url'),
        nodeStatic = require('node-static'),
        imageMagick = require('imagemagick'),
        async = require('async'),
        _ = require('underscore'),
        cb = require('couchbase'),
        tools = require('./tools.js'),
        models = require('./models.js'),
        bucket = null,

        options = {
            tmpDir: __dirname + '/temp',
            publicDir: __dirname + '/public',
            uploadDir: __dirname + '/public/files',
            uploadUrl: '/files/',
            maxPostSize: 5000000, // 4mb
            minFileSize: 1,
            maxFileSize: 4900000, // 4mb
            acceptFileTypes: /.+/i,
            // Files not matched by this regular expression force a download dialog,
            // to prevent executing any scripts in the context of the service domain:
            inlineFileTypes: /\.(gif|jpe?g|png)$/i,
            imageTypes: /\.(gif|jpe?g|png)$/i,
            imageVersions: {
                'thumbnail': {
                    width: 200,
                    height: 200
                }
            },
            accessControl: {
                allowOrigin: '*',
                allowMethods: 'OPTIONS, HEAD, GET, POST, PUT, DELETE',
                allowHeaders: 'Content-Type, Content-Range, Content-Disposition'
            },
            /* Uncomment and edit this section to provide the service via HTTPS:
             ssl: {
             key: fs.readFileSync('/Applications/XAMPP/etc/ssl.key/server.key'),
             cert: fs.readFileSync('/Applications/XAMPP/etc/ssl.crt/server.crt')
             },
             */
            nodeStatic: {
                cache: 3600 // seconds to cache served files
            }
        },
        getCfg = function(){
            var cfg;
            var configFilename = 'config.json';
            if (fs.existsSync(configFilename)) {
                cfg = JSON.parse(fs.readFileSync(configFilename));
            } else {
                tools.logd(configFilename + " not found. Using default");
                cfg = { };
            }

            return cfg;
        },
        utf8encode = function (str) {
            return unescape(encodeURIComponent(str));
        },
        fileServer = new nodeStatic.Server(options.publicDir, options.nodeStatic),
        nameCountRegexp = /(?:(?: \(([\d]+)\))?(\.[^.]+))?$/,
        nameCountFunc = function (s, index, ext) {
            return ' (' + ((parseInt(index, 10) || 0) + 1) + ')' + (ext || '');
        },

        checkOverLimit = function(uid,cb){

            // check if user uploaded too many files in last x hours...
            var cfg = getCfg();
            var count = 0;

            // get uid/file stubs from db
            var params =  {
                "stale"         : "false",
                "startkey"      : [uid,9007199254740992],
                "endkey"        : [uid,0],
                "descending"    : true,
                "connection_timeout" : 60000,
                "limit" : cfg.fileUploadLimit
            };
            var error;
            var q = bucket.view("stats", "uploads_in_interval", params);
            q.query(function(err,view){

                if(err){
                    tools.logd("Error checking upload limit interval for uid: "+uid)
                    return;
                }

                var hrsAgo = Date.now()-cfg.fileUploadLimitPeriod;
                _.map(view,function(assoc){
                    if(assoc.key[1] > hrsAgo){
                        ++count;
                    }
                });

                var hrs = cfg.fileUploadLimitPeriod/60/60/1000;

                if(count >= cfg.fileUploadLimit){
                    error = "Upload limit of "+cfg.fileUploadLimit+" files per "+cfg.fileUploadLimitPeriod+"h reached."
                    tools.logd("User reached their upload limit with: "+count+" uploads in last "+hrs+" hours.");
                }

                tools.logd(uid+" has uploaded "+count+" files in last "+hrs+" hours");

                cb(!error);
            });
        },

        FileInfo = function (file) {
            this.name = file.name;
            this.size = file.size;
            this.type = file.type;
            this.deleteType = 'DELETE';
        },
        UploadHandler = function (req, res, callback) {
            this.req = req;
            this.res = res;
            this.callback = callback;
        },
        serve = function (req, res) {
            res.setHeader(
                'Access-Control-Allow-Origin',
                options.accessControl.allowOrigin
            );
            res.setHeader(
                'Access-Control-Allow-Methods',
                options.accessControl.allowMethods
            );
            res.setHeader(
                'Access-Control-Allow-Headers',
                options.accessControl.allowHeaders
            );
            var handleResult = function (result, redirect) {
                    if (redirect) {
                        res.writeHead(302, {
                            'Location': redirect.replace(
                                /%s/,
                                encodeURIComponent(JSON.stringify(result))
                            )
                        });
                        res.end();
                    } else {
                        res.writeHead(200, {
                            'Content-Type': req.headers.accept
                                .indexOf('application/json') !== -1 ?
                                'application/json' : 'text/plain'
                        });
                        res.end(JSON.stringify(result));
                    }
                },
                setNoCacheHeaders = function () {
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                    res.setHeader('Content-Disposition', 'inline; filename="files.json"');
                },
                handler = new UploadHandler(req, res, handleResult);

            switch (req.method) {
                case 'OPTIONS':
                    res.end();
                    break;
                case 'HEAD':
                case 'GET':
                    if (req.url === '/') {
                        setNoCacheHeaders();
                        if (req.method === 'GET') {
                            handler.get();
                        } else {
                            res.end();
                        }
                    // report current file upload quota limitations
                    }else if(req.url == "/limit"){
                        var cfg = getCfg();
                        res.end(JSON.stringify({"fileUploadLimit":cfg.fileUploadLimit,"fileUploadLimitPeriod":cfg.fileUploadLimitPeriod}));

                    // report if uid is over upload limit
                    } else if( tools.startsWith(req.url,"/overLimit")){
                        var qry = url.parse(req.url,true).query;
                        checkOverLimit(qry.uid,function(allowed){
                            res.end(JSON.stringify(!allowed));
                        });
                    } else {
                        fileServer.serve(req, res);
                    }
                    break;
                case 'POST':
                    setNoCacheHeaders();
                    handler.post();
                    break;
                case 'DELETE':
                    handler.destroy();
                    break;
                default:
                    res.statusCode = 405;
                    res.end();
            }
        };
    fileServer.respond = function (pathname, status, _headers, files, stat, req, res, finish) {
        // Prevent browsers from MIME-sniffing the content-type:
        _headers['X-Content-Type-Options'] = 'nosniff';
        if (!options.inlineFileTypes.test(files[0])) {
            // Force a download dialog for unsafe file extensions:
            _headers['Content-Type'] = 'application/octet-stream';
            _headers['Content-Disposition'] = 'attachment; filename="' +
                utf8encode(path.basename(files[0])) + '"';
        }
        nodeStatic.Server.prototype.respond
            .call(this, pathname, status, _headers, files, stat, req, res, finish);
    };
    FileInfo.prototype.validate = function () {
        if (options.minFileSize && options.minFileSize > this.size) {
            this.error = 'File is too small';
        } else if (options.maxFileSize && options.maxFileSize < this.size) {
            this.error = 'File is too big';
        } else if (!options.acceptFileTypes.test(this.name)) {
            this.error = 'Filetype not allowed';
        }
        return !this.error;
    };
    FileInfo.prototype.safeName = function () {
        // Prevent directory traversal and creating hidden system files:
        this.name = path.basename(this.name).replace(/^\.+/, '');
        // Prevent overwriting existing files:
        while (_existsSync(options.uploadDir + '/' + this.name)) {
            this.name = this.name.replace(nameCountRegexp, nameCountFunc);
        }
    };
    FileInfo.prototype.initUrls = function (req) {
        if (!this.error) {
            var that = this,
                baseUrl = (options.ssl ? 'https:' : 'http:') +
                    '//' + req.headers.host + options.uploadUrl;
            this.url = this.deleteUrl = baseUrl + encodeURIComponent(this.name);
            Object.keys(options.imageVersions).forEach(function (version) {
                if (_existsSync(
                    options.uploadDir + '/' + version + '/' + that.name
                )) {
                    that[version + 'Url'] = baseUrl + version + '/' +
                        encodeURIComponent(that.name);
                }
            });
        }
    };
    UploadHandler.prototype.get = function () {
        var handler = this,
            files = [];
        fs.readdir(options.uploadDir, function (err, list) {
            list.forEach(function (name) {
                var stats = fs.statSync(options.uploadDir + '/' + name),
                    fileInfo;
                if (stats.isFile() && name[0] !== '.') {
                    fileInfo = new FileInfo({
                        name: name,
                        size: stats.size
                    });
                    fileInfo.initUrls(handler.req);
                    files.push(fileInfo);
                }
            });
            handler.callback({files: files});
        });
    };
    UploadHandler.prototype.post = function () {

        var handler = this;
        var uid = handler.req.url.replace("/?uid=","");

        // check to see if user is over the upload limit, if not process request, otherwise kill socket
        checkOverLimit(uid,function(allowed){

            if(!allowed){
                handler.req.connection.destroy();
                tools.logd("Blocked upload request for "+uid);
                return;
            }

            var form = new formidable.IncomingForm(),
                tmpFiles = [],
                files = [],
                map = {},
                counter = 1,
                redirect,
                finish = function () {
                    counter -= 1;
                    if (!counter) {
                        files.forEach(function (fileInfo) {
                            fileInfo.initUrls(handler.req);
                        });
                        handler.callback({files: files}, redirect);
                    }
                };

            form.uid = uid;
            form.uploadDir = options.tmpDir;
            form.on('fileBegin', function (name, file) {

                tools.logd("Beginning upload of: "+file.name+" for uid: "+form.uid);

                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file, handler.req, true);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);

            }).on('field', function (name, value) {

                    if (name === 'redirect') {
                        redirect = value;
                    }

            }).on('file', function (name, file) {

                var fileInfo = map[path.basename(file.path)];
                fileInfo.size = file.size;
                if (!fileInfo.validate()) {
                    fs.unlink(file.path);
                    return;
                }
                fs.renameSync(file.path, options.uploadDir + '/' + fileInfo.name);
                if (options.imageTypes.test(fileInfo.name)) {
                    Object.keys(options.imageVersions).forEach(function (version) {
                        counter += 1;

                        var opts = options.imageVersions[version];

                        // Exclude gifs (animated or not) from resizing, and create a symlink in /version to the
                        // original file instead. Takes way too much CPU and is a total waste of space and possibly
                        // bandwith since resized animated gifs are about the same size! Let the DOM and browser
                        // deal with resizing.
                        if( fileInfo.name.endsWith('gif')){
                            tools.logd(fileInfo.name+" is a GIF. Skipping resize, creating symlink in /"+version+"/ instead.");
                            fs.symlink(
                                options.uploadDir + '/' + fileInfo.name,
                                options.uploadDir + '/' + version + '/' + fileInfo.name,
                                'file',
                                finish
                            );
                        }else{
                            imageMagick.resize({
                                width: opts.width,
                                height: opts.height,
                                quality: 0.9,
                                progressive: true,
                                srcPath: options.uploadDir + '/' + fileInfo.name,
                                dstPath: options.uploadDir + '/' + version + '/' + fileInfo.name
                            },  function(e, stdout, stderr){
                                    if(e) tools.logd("Error resizing thumbnail (imageMagick): "+e);
                                    finish();
                            });
                        }

                    });
                }


                // log file association to DB
                try{
                    // log file association for the uploader
                    var keys = Object.keys(map);
                    var fileAssoc = new models.FileAssociation({uid:form.uid,file:map[keys[0]].name});

                    bucket.set("file_"+tools.guid(),fileAssoc,function(e){
                        if(e){
                            tools.logd("Error associating file: "+fileAssoc);
                        }
                    });
                }catch(e){
                    tools.logd("Couldn's store stub: "+e);
                }

                tools.logd("Upload of "+fileInfo.name+" complete.");

            }).on('aborted', function () {
                tmpFiles.forEach(function (file) {
                    fs.unlink(file);
                });
            }).on('error', function (e) {
                tools.logd("form.on('error'): "+e);
            }).on('progress', function (bytesReceived) {
                if (bytesReceived > options.maxPostSize) {
                    handler.req.connection.destroy();
                }
            }).on('end', finish).parse(handler.req);

        });
    };
    UploadHandler.prototype.destroy = function () {
        var handler = this,
            fileName;
        if (handler.req.url.slice(0, options.uploadUrl.length) === options.uploadUrl) {
            fileName = path.basename(decodeURIComponent(handler.req.url));
            if (fileName[0] !== '.') {
                fs.unlink(options.uploadDir + '/' + fileName, function (ex) {
                    Object.keys(options.imageVersions).forEach(function (version) {
                        fs.unlink(options.uploadDir + '/' + version + '/' + fileName);
                    });
                    handler.callback({success: !ex});
                });
                return;
            }
        }
        handler.callback({success: false});
    };
    tools.logd('Starting file server...');
    bucket = new cb.Connection(getCfg(), function(err) {
        if (err) {
            throw "Cannot connect to couchbase. Reason: "+err;
        }
        if (options.ssl) {
            require('https').createServer(options.ssl, serve).listen(port);
        } else {
            require('http').createServer(serve).listen(port);
        }
        tools.logd('File server started.');
    });

}(8888));