/** 
 * Shows how to embed an app inside loginapp.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {i18n} from "/framework/js/i18n.mjs";
import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";

const MODULE_PATH = util.getModulePathFromURL(import.meta.url), AI_WORKSHOP_VIEW = "aiworkshop", IMAGE_DATA = "data:image",
    API_GET_AIAPPS = "getorgaiapps", CUSTOM_INTERFACE = "custom", DEFAULT_MAX_PATH_LENGTH = 50;

let loginappMain;

const main = async (data, mainLoginAppModule) => {
    window.monkshu_env.apps[APP_CONSTANTS.APP_NAME] = {
        ...(window.monkshu_env.apps[APP_CONSTANTS.APP_NAME]||{}), neuranetapp};
    loginappMain = mainLoginAppModule; loginappMain.addGoHomeListener(_ => session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW));
    APP_CONSTANTS.VIEWS_PATH = util.resolveURL(`${APP_CONSTANTS.APP_PATH}/views`);
    await _createdata(data); 
    data.maincontent = data.viewcontent;     // this is the main entry point
}

async function refreshAIApps() {
    const loginresponse = session.get(APP_CONSTANTS.LOGIN_RESPONSE);
    const id = session.get(APP_CONSTANTS.USERID).toString(), org = session.get(APP_CONSTANTS.USERORG).toString();
    const aiAppsResult = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_GET_AIAPPS}`, "GET", {id, org, unpublished: false}, true);
    if (aiAppsResult && aiAppsResult.result) loginresponse.apps = aiAppsResult.aiapps;
    session.set(APP_CONSTANTS.LOGIN_RESPONSE, loginresponse);
}

async function _createdata(data) {   
    await refreshAIApps();
    let viewPath, aiendpoint, views, activeaiapp; delete data.showhome; delete data.shownotifications;
    const loginresponse = session.get(APP_CONSTANTS.LOGIN_RESPONSE), appsAllowed = [...(loginresponse?.apps||[])],
        isAdmin = session.get(APP_CONSTANTS.CURRENT_USERROLE).toString() == "admin";
        const allaiApps = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_GET_AIAPPS}`, "GET", {id:loginresponse.id, org:loginresponse.org, unpublished: true}, true);
        const isAppAdmin =  (allaiApps.aiapps.some(app => app.admins?.includes(loginresponse.id)) || allaiApps.aiapps.some(app=> app.is_user_appadmin === true));
    if (isAdmin || isAppAdmin) appsAllowed.push({id: AI_WORKSHOP_VIEW, interface: {type: AI_WORKSHOP_VIEW,
        label: await i18n.get(`ViewLabel_${AI_WORKSHOP_VIEW}`)}});  // admins can run AI workshops always

    const _getAppToForceLoadOrFalse = _ => session.get(APP_CONSTANTS.FORCE_LOAD_VIEW)?.toString()||false;
    const _loadForcedView = appid => {
        if (appsAllowed.length > 1) data.showhome = true;
        const appidToOpen = appid||_getAppToForceLoadOrFalse(), 
            app = (appsAllowed.filter(app => app.id == appidToOpen))[0];
        viewPath = getViewPath(app, loginresponse.org);
        aiendpoint = app.endpoint; activeaiapp = app;
        data.showSidebar = !!activeaiapp && activeaiapp.interface?.type !== APP_CONSTANTS.VIEW_CHOOSER ;
        if (appidToOpen=='aiworkshop') data.showSidebar=false;
    }

     // load the given app if forced, or if apps allowed is just one, else load chooser
    if (appsAllowed.length == 1) _loadForcedView(appsAllowed[0].id);
    else if (_getAppToForceLoadOrFalse()) _loadForcedView();   
    else {    // left with chooser
        viewPath = `${APP_CONSTANTS.VIEWS_PATH}/${APP_CONSTANTS.VIEW_CHOOSER}`;
        views = []; 
        for (const app of appsAllowed) if (app.interface != APP_CONSTANTS.VIEW_CHOOSER) views.push(  // views we can choose from
            {viewicon: (app.interface?.icon && app.interface.icon.toLowerCase().startsWith(IMAGE_DATA)) ? app.interface.icon :
                app.interface.type == CUSTOM_INTERFACE ? `${getViewPath(app, loginresponse.org)}/img/logo.svg` : 
                `${APP_CONSTANTS.VIEWS_PATH}/${app.interface.type.toString()}/img/icon.svg`, 
            viewlabel: app.interface.label||await i18n.get(`ViewLabel_${app.interface.type.toString()}`), 
            viewid: app.id});
            data.showSidebar = false;   // chooser: no sidebar
    } 

    // now load the view's HTML
    const viewURL = `${viewPath}/main.html`, viewMainMJS = `${viewPath}/js/main.mjs`;
    data.viewpath = viewPath; data.aiendpoint = aiendpoint; data.activeaiapp = activeaiapp; 
    data.icons = {}; data.showrefresh = true;
    try { const viewMain = await import(viewMainMJS); await viewMain.main.initView(data, neuranetapp); }    // init the view before loading it
    catch (err) { LOG.error(`Error in initializing view ${viewPath} due to error ${err}.`); }
    data.viewcontent = await router.loadHTML(viewURL, {...data, views}); 
}

const closeview = _ => loginappMain.gohome();

async function openView(appid) {
    session.set(APP_CONSTANTS.FORCE_LOAD_VIEW, appid);
    const id = session.get(APP_CONSTANTS.USERID);
    const org = session.get(APP_CONSTANTS.USERORG);
    let time = new Date().toISOString();
    const chat_filename = `_${org}_${id}_${time}.ndjson`;
    session.set(APP_CONSTANTS.CHAT_FILENAME, chat_filename);
    const {loginmanager} = await import (`${APP_CONSTANTS.LIB_PATH}/loginmanager.mjs`);
    loginmanager.addLogoutListener(`${MODULE_PATH}/neuranetapp.mjs`, "neuranetapp", "onlogout");
    session.remove(APP_CONSTANTS.CHAT_SESSION_ID);
    session.remove(APP_CONSTANTS.CHAT_HISTORY_CONVERSATION);
    router.navigate(APP_CONSTANTS.MAIN_HTML);
}

function onlogout() {session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW);}

function getViewPath(app, org) {
    if (app.interface.type == CUSTOM_INTERFACE) return `${APP_CONSTANTS.VIEWS_PATH}/custom/${_convertToPathFriendlyString(org)}/${_convertToPathFriendlyString(app.id)}`;
    else return `${APP_CONSTANTS.VIEWS_PATH}/${app.interface.type}`;
}

function _convertToPathFriendlyString(s, maxPathLength=DEFAULT_MAX_PATH_LENGTH) {
	let tentativeFilepath = encodeURIComponent(s);
	if (tentativeFilepath.endsWith(".")) tentativeFilepath = tentativeFilepath.substring(0, tentativeFilepath.length - 1) + "%2E";
		
	if (tentativeFilepath.length > maxPathLength) {
		tentativeFilepath = tentativeFilepath + "." + Date.now();
		tentativeFilepath = tentativeFilepath.substring(tentativeFilepath.length-maxPathLength);
	}
	
	return tentativeFilepath;
}


export const neuranetapp = {main, openView, closeview, onlogout, refreshAIApps};